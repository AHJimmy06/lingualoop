const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { NestFactory } = require('@nestjs/core');
const { Module } = require('@nestjs/common');
const { HealthController } = require('../dist/health.controller.js');
const { LINGUALOOP_QUERY_EXECUTOR } = require('../dist/db/postgres.js');
const { GoogleAuthController, GOOGLE_AUTH_RATE_LIMITER, GoogleAuthRateLimiter } = require('../dist/auth/google-auth.controller.js');
const { ConfiguredVerifiedRequestGuard, GOOGLE_AUTH_FLOW, REFRESH_SESSION } = require('../dist/auth/google-auth.providers.js');
const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../dist/auth/auth-store.providers.js');
const { LinguaLoopTokenService } = require('../dist/auth/lingualoop-token.service.js');
const { GOOGLE_BROWSER_POLICY, createGoogleBrowserPolicy } = require('../dist/auth/google-browser-policy.js');
const { GoogleCodeExchange } = require('../dist/auth/google-code-exchange.js');
const { InvalidBearerTokenError } = require('../dist/auth/verified-request.guard.js');

const state = 'A'.repeat(43);
const stateCookie = `lingualoop-oauth-state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`;
const clearCookie = 'lingualoop-oauth-state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
const refreshCookie = 'lingualoop-refresh=refresh-test; Path=/; HttpOnly; SameSite=Lax; Max-Age=600';
const refreshCredentialCookie = 'lingualoop-refresh=refresh-test';
const webOrigin = 'http://localhost:5001';
const ownerId = '550e8400-e29b-41d4-a716-446655440000';
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const accessToken = 'valid-access-token';
const refreshForSession = `${sessionId}.${'A'.repeat(43)}`;

async function server(t, overrides = {}) {
  let consumed = false;
  const calls = [];
  const flow = {
    async begin() { calls.push('begin'); return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`, stateCookie }; },
    clearStateCookie() { return clearCookie; },
    failureRedirectUrl() { return `${webOrigin}/login?status=oauth-failed`; },
    async finish(input) {
      calls.push(input);
      if (consumed) throw new Error('replay');
      if (input.cookieHeader !== `lingualoop-oauth-state=${state}` || input.state !== state || input.code !== 'code') throw new Error('invalid');
      consumed = true;
      return { redirectUrl: 'http://localhost:5001', refreshCookie, stateCookie: clearCookie };
    },
    ...overrides,
  };
  const refreshCalls = [];
  const compensationCalls = [];
  const logoutCalls = [];
  const refreshSession = {
    async logout(binding) {
      logoutCalls.push(binding);
      if (overrides.logoutError) throw new Error('private store failure');
    },
    async refresh(credential) {
      refreshCalls.push(credential);
      if (overrides.refreshError || credential !== 'refresh-test') throw new Error('generic failure');
      return {
        accessToken: 'access-token-test',
        refreshCredential: 'rotated-test',
        expiresAtMs: Date.now() + 6 * 24 * 60 * 60 * 1000,
        async compensateDeliveryFailure() { compensationCalls.push(['verified-owner', 'verified-session']); },
      };
    },
  };
  const browserPolicy = overrides.browserPolicy ?? createGoogleBrowserPolicy({ callbackUrl: 'http://localhost:5000/auth/google/callback', webOrigin });
  class TestModule {}
  const app = await NestFactory.create({
    module: TestModule,
    controllers: [GoogleAuthController],
    providers: [
      { provide: GOOGLE_AUTH_FLOW, useValue: flow },
      { provide: GOOGLE_AUTH_RATE_LIMITER, useValue: new GoogleAuthRateLimiter() },
      { provide: REFRESH_SESSION, useValue: refreshSession },
      { provide: GOOGLE_BROWSER_POLICY, useValue: browserPolicy },
      { provide: LinguaLoopTokenService, useValue: { async verifyBearerToken(token) {
        if (token !== accessToken) throw new InvalidBearerTokenError();
        return { issuer: 'local', subject: ownerId, sessionId };
      } } },
      { provide: LINGUALOOP_IDENTITY_STORE, useValue: {
        async findOwnerByIdentity() { return overrides.resolvedOwner ?? ownerId; },
        async findAccountByOwner() { return { name: 'Test User', email: 'test@example.org', role: 'student' }; },
      } },
      { provide: LINGUALOOP_SESSION_STORE, useValue: { async isSessionActive(owner, session) { return !overrides.inactiveSession && owner === ownerId && session === sessionId; } } },
      { provide: ConfiguredVerifiedRequestGuard, useClass: ConfiguredVerifiedRequestGuard },
    ],
  }, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address();
  return { base: `http://127.0.0.1:${address.port}`, calls, refreshCalls, compensationCalls, logoutCalls };
}

function duplicateAuthorizationRequest(base) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}/auth/logout`, {
      method: 'POST',
      headers: { origin: webOrigin, cookie: refreshCredentialCookie, authorization: [`Bearer ${accessToken}`, `Bearer ${accessToken}`] },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

function assertSafeHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
}

test('missing Google settings leave Nest health routes live and do not mount auth routes', async (t) => {
  const names = [
    'GOOGLE_CALLBACK_URL', 'LINGUALOOP_WEB_ORIGIN', 'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_CALLBACK_URL', 'LINGUALOOP_TOKEN_SIGNING_KEY', 'LINGUALOOP_TOKEN_SIGNING_KEY_FILE',
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  let AppModule;
  try {
    AppModule = require('../dist/app.module.js').AppModule;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const appControllers = Reflect.getMetadata('controllers', AppModule);
  assert.ok(appControllers.includes(HealthController));
  assert.equal(appControllers.some((controller) => controller.name === 'GoogleAuthController'), false);

  class HealthOnlyTestModule {}
  Module({
    // This fixture intentionally verifies only the health route; wiring every AppModule
    // controller here would require the application's full auth/database dependency graph.
    controllers: [HealthController],
    providers: [{ provide: LINGUALOOP_QUERY_EXECUTOR, useValue: { async query() { return { rows: [{ '?column?': 1 }] }; } } }],
  })(HealthOnlyTestModule);
  const app = await NestFactory.create(HealthOnlyTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  assert.equal((await fetch(`${base}/auth/google`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/auth/google/callback?code=partial`)).status, 404);
  assert.equal((await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { origin: webOrigin } })).status, 404);
});

test('malformed present Google settings keep health routes live and disable auth routes', async (t) => {
  const names = [
    'GOOGLE_CALLBACK_URL', 'LINGUALOOP_WEB_ORIGIN', 'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_CALLBACK_URL', 'LINGUALOOP_TOKEN_SIGNING_KEY', 'LINGUALOOP_TOKEN_SIGNING_KEY_FILE',
  ];
  const valid = {
    GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback',
    LINGUALOOP_WEB_ORIGIN: 'http://localhost:5001',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    LINGUALOOP_TOKEN_SIGNING_KEY: 'a'.repeat(32),
  };
  const malformed = [
    { ...valid, GOOGLE_CALLBACK_URL: 'not a URL' },
    { ...valid, LINGUALOOP_WEB_ORIGIN: 'http://127.0.0.1:5001' },
    { ...valid, GOOGLE_CLIENT_ID: ' contains whitespace ' },
    { ...valid, GOOGLE_CLIENT_SECRET: '   ' },
    { ...valid, GOOGLE_CLIENT_ID: '   ' },
    { ...valid, LINGUALOOP_TOKEN_SIGNING_KEY: 'too-short' },
    { ...valid, LINGUALOOP_TOKEN_SIGNING_KEY: undefined },
    { ...valid, LINGUALOOP_TOKEN_SIGNING_KEY_FILE: 'relative/key' },
    { ...valid, LINGUALOOP_TOKEN_SIGNING_KEY_FILE: '/synthetic/key' },
    { ...valid, LINGUALOOP_TOKEN_SIGNING_KEY_FILE: '/synthetic/key', LINGUALOOP_TOKEN_SIGNING_KEY: 'b'.repeat(32) },
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  let appControllers;
  try {
    for (const settings of malformed) {
      for (const name of names) {
        if (settings[name] === undefined) delete process.env[name];
        else process.env[name] = settings[name];
      }
      const modulePath = require.resolve('../dist/app.module.js');
      delete require.cache[modulePath];
      const AppModule = require(modulePath).AppModule;
      appControllers = Reflect.getMetadata('controllers', AppModule);
      assert.ok(appControllers.includes(HealthController));
      assert.equal(appControllers.some((controller) => controller.name === 'GoogleAuthController'), false);
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  class HealthOnlyTestModule {}
  Module({
    controllers: [HealthController],
    providers: [{ provide: LINGUALOOP_QUERY_EXECUTOR, useValue: { async query() { return { rows: [{ '?column?': 1 }] }; } } }],
  })(HealthOnlyTestModule);
  const app = await NestFactory.create(HealthOnlyTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  assert.equal((await fetch(`${base}/auth/google`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/auth/google/callback?code=partial`)).status, 404);
  assert.equal((await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { origin: webOrigin } })).status, 404);
});

test('fully valid Google settings continue to register auth routes and providers', () => {
  const names = [
    'GOOGLE_CALLBACK_URL', 'LINGUALOOP_WEB_ORIGIN', 'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_CALLBACK_URL', 'LINGUALOOP_TOKEN_SIGNING_KEY', 'LINGUALOOP_TOKEN_SIGNING_KEY_FILE',
  ];
  const settings = {
    GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback',
    LINGUALOOP_WEB_ORIGIN: 'http://localhost:5001',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    LINGUALOOP_TOKEN_SIGNING_KEY: 'a'.repeat(32),
  };
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (settings[name] === undefined) delete process.env[name];
      else process.env[name] = settings[name];
    }
    const modulePath = require.resolve('../dist/app.module.js');
    delete require.cache[modulePath];
    const AppModule = require(modulePath).AppModule;
    const appControllers = Reflect.getMetadata('controllers', AppModule);
    const appProviders = Reflect.getMetadata('providers', AppModule);
    assert.ok(appControllers.includes(GoogleAuthController));
    assert.ok(appProviders.some((provider) => provider && provider.provide === GOOGLE_AUTH_FLOW));
    assert.ok(appProviders.some((provider) => provider && provider.provide === REFRESH_SESSION));
    assert.ok(appProviders.includes(ConfiguredVerifiedRequestGuard));
    assert.ok(appProviders.some((provider) => provider && provider.provide === GOOGLE_BROWSER_POLICY));
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('Google exchange configuration fails closed when explicit client credentials are absent', () => {
  assert.throws(() => new GoogleCodeExchange({ env: {
    GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback',
    LINGUALOOP_WEB_ORIGIN: 'http://localhost:5001',
  } }), /credentials must be explicitly configured/);
});

test('start redirects only to Google authorization and sets the browser state cookie with safe headers', async (t) => {
  const { base } = await server(t);
  const response = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(response.headers.get('set-cookie'), /^lingualoop-oauth-state=/);
  assertSafeHeaders(response);
  assert.doesNotMatch(response.headers.get('location'), /accessToken|refreshCredential/);
});

test('start failures clear a prior browser-state cookie and return a generic response', async (t) => {
  const { base } = await server(t, { async begin() { throw new Error('sensitive failure'); } });
  const response = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), clearCookie);
  assert.equal(await response.text(), 'Google login could not be completed.');
  assertSafeHeaders(response);
});

test('callback redirects to configured web origin, sets only cookies, and never puts credentials in URL', async (t) => {
  const { base } = await server(t);
  const response = await fetch(`${base}/auth/google/callback?code=code&state=${state}`, {
    headers: { cookie: `lingualoop-oauth-state=${state}` }, redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'http://localhost:5001');
  assertSafeHeaders(response);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /Max-Age=0/);
  assert.match(cookies[1], /^lingualoop-refresh=/);
  assert.doesNotMatch(response.headers.get('location'), /token|code|state=/i);
});

test('logout revokes the verified owner/session, clears the cookie, and accepts an absent refresh cookie', async (t) => {
  const { base, logoutCalls } = await server(t);
  const response = await fetch(`${base}/auth/logout`, {
    method: 'POST', headers: { origin: webOrigin, authorization: `Bearer ${accessToken}`, cookie: `lingualoop-refresh=${refreshForSession}` },
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.deepEqual(logoutCalls, [{ ownerId, sessionId }]);
  assertSafeHeaders(response);

  const absent = await fetch(`${base}/auth/logout`, {
    method: 'POST', headers: { origin: webOrigin, authorization: `Bearer ${accessToken}` },
  });
  assert.equal(absent.status, 204);
  assert.match(absent.headers.get('set-cookie'), /Max-Age=0/);
  assert.deepEqual(logoutCalls, [{ ownerId, sessionId }, { ownerId, sessionId }]);
});

test('logout rejects wrong or missing Origin without clearing cookies or revoking', async (t) => {
  const { base, logoutCalls } = await server(t);
  for (const origin of [undefined, 'null', 'http://localhost:5000', 'http://127.0.0.1:5001']) {
    const headers = { authorization: `Bearer ${accessToken}`, cookie: `lingualoop-refresh=${refreshForSession}` };
    if (origin !== undefined) headers.origin = origin;
    const response = await fetch(`${base}/auth/logout`, { method: 'POST', headers });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), 'Google login could not be completed.');
  }
  assert.deepEqual(logoutCalls, []);
});

test('logout requires one valid bearer and active owner-scoped session before handler mutation', async (t) => {
  const { base, logoutCalls } = await server(t);
  for (const authorization of [undefined, 'Bearer expired-token']) {
    const headers = { origin: webOrigin, cookie: `lingualoop-refresh=${refreshForSession}` };
    if (authorization !== undefined) headers.authorization = authorization;
    assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', headers })).status, 401);
  }
  assert.equal(await duplicateAuthorizationRequest(base), 401);
  const mismatch = await server(t, { resolvedOwner: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' });
  const denied = await fetch(`${mismatch.base}/auth/logout`, {
    method: 'POST', headers: { origin: webOrigin, authorization: `Bearer ${accessToken}` },
  });
  assert.equal(denied.status, 401);
  assert.deepEqual(logoutCalls, []);
});

test('logout rejects malformed, duplicate, and session-mismatched cookies without revoking', async (t) => {
  const { base, logoutCalls } = await server(t);
  for (const cookie of [
    'lingualoop-refresh=malformed',
    `lingualoop-refresh=${refreshForSession}; lingualoop-refresh=${refreshForSession}`,
    `lingualoop-refresh=223e4567-e89b-42d3-a456-426614174000.${'A'.repeat(43)}`,
  ]) {
    const response = await fetch(`${base}/auth/logout`, {
      method: 'POST', headers: { origin: webOrigin, authorization: `Bearer ${accessToken}`, cookie },
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(await response.text(), 'Google login could not be completed.');
    assertSafeHeaders(response);
  }
  assert.deepEqual(logoutCalls, []);
});

test('logout store failures are generic and clear only on allowed Origin', async (t) => {
  const { base } = await server(t, { logoutError: true });
  const response = await fetch(`${base}/auth/logout`, {
    method: 'POST', headers: { origin: webOrigin, authorization: `Bearer ${accessToken}` },
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await response.text(), 'Google login could not be completed.');
  assertSafeHeaders(response);
});

test('logout is rate-limited by socket peer and clears only allowed-origin cookie', async (t) => {
  const { base } = await server(t);
  for (let i = 0; i < 30; i += 1) {
    const response = await fetch(`${base}/auth/logout`, {
      method: 'POST', headers: { origin: webOrigin, authorization: `Bearer ${accessToken}` },
    });
    assert.equal(response.status, 204);
  }
  const limited = await fetch(`${base}/auth/logout`, {
    method: 'POST', headers: { origin: webOrigin, authorization: `Bearer ${accessToken}` },
  });
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('set-cookie'), /Max-Age=0/);
  assertSafeHeaders(limited);
});

test('refresh rotates once, returns only a no-store JSON access token and preserves absolute cookie expiry', async (t) => {
  const { base, refreshCalls, compensationCalls } = await server(t);
  const response = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { origin: webOrigin, cookie: refreshCredentialCookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accessToken: 'access-token-test' });
  assert.deepEqual(refreshCalls, ['refresh-test']);
  assert.deepEqual(compensationCalls, []);
  const maxAge = Number(response.headers.get('set-cookie').match(/Max-Age=(\d+)/)[1]);
  assert.ok(maxAge > 500_000 && maxAge <= 518_400);
  assertSafeHeaders(response);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.doesNotMatch(response.url, /access-token|refresh-test|rotated-test/);
  assert.doesNotMatch(response.headers.get('location') || '', /token/i);
});

test('refresh cookie assembly failure compensates once and delivers only the generic error', async (t) => {
  const policy = createGoogleBrowserPolicy({ callbackUrl: 'http://localhost:5000/auth/google/callback', webOrigin });
  const { base, compensationCalls } = await server(t, {
    browserPolicy: { ...policy, refreshCookie() { throw new Error('cookie assembly detail'); } },
  });
  const response = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { origin: webOrigin, cookie: refreshCredentialCookie } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), 'lingualoop-refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  assert.equal(await response.text(), 'Google login could not be completed.');
  assert.deepEqual(compensationCalls, [['verified-owner', 'verified-session']]);
  assert.doesNotMatch(response.headers.get('set-cookie'), /rotated-test/);
  assertSafeHeaders(response);
});

test('refresh rejects missing, null, wrong-origin/scheme/port before cookie or core access and does not clear', async (t) => {
  const { base, refreshCalls } = await server(t);
  for (const origin of [undefined, 'null', 'https://localhost:5001', 'http://localhost:5000', 'http://127.0.0.1:5001']) {
    const headers = { cookie: refreshCredentialCookie };
    if (origin !== undefined) headers.origin = origin;
    const response = await fetch(`${base}/auth/refresh`, { method: 'POST', headers });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), 'Google login could not be completed.');
    assertSafeHeaders(response);
  }
  assert.deepEqual(refreshCalls, []);
});

test('refresh malformed, missing, duplicate cookies and replay return generic failures and clear cookie', async (t) => {
  const { base, refreshCalls } = await server(t);
  for (const cookie of [undefined, 'other=value', 'broken', `${refreshCredentialCookie}; lingualoop-refresh=second`]) {
    const headers = { origin: webOrigin };
    if (cookie !== undefined) headers.cookie = cookie;
    const response = await fetch(`${base}/auth/refresh`, { method: 'POST', headers });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(await response.text(), 'Google login could not be completed.');
    assertSafeHeaders(response);
  }
  const replay = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { origin: webOrigin, cookie: 'lingualoop-refresh=spent' } });
  assert.equal(replay.status, 401);
  assert.match(replay.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(refreshCalls.length, 1);
});

test('refresh is rate-limited per request IP and clears only allowed-origin browser cookie', async (t) => {
  const { base } = await server(t);
  for (let i = 0; i < 30; i += 1) {
    const response = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { origin: webOrigin, cookie: refreshCredentialCookie } });
    assert.equal(response.status, 200);
  }
  const limited = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { origin: webOrigin, cookie: refreshCredentialCookie } });
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('set-cookie'), /Max-Age=0/);
  assertSafeHeaders(limited);
});

test('callback errors and replay are generic and always clear state cookie', async (t) => {
  const { base } = await server(t);
  const url = `${base}/auth/google/callback?code=code&state=${state}`;
  const headers = { cookie: `lingualoop-oauth-state=${state}` };
  const first = await fetch(url, { headers, redirect: 'manual' });
  assert.equal(first.status, 302);
  const replay = await fetch(url, { headers, redirect: 'manual' });
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.get('set-cookie'), clearCookie);
  assert.equal(replay.headers.get('location'), `${webOrigin}/login?status=oauth-failed`);
  assertSafeHeaders(replay);

  const invalid = await fetch(`${base}/auth/google/callback?error=access_denied`, { redirect: 'manual' });
  assert.equal(invalid.status, 302);
  assert.equal(invalid.headers.get('set-cookie'), clearCookie);
  assert.equal(invalid.headers.get('location'), `${webOrigin}/login?status=oauth-failed`);
});

test('start and callback have bounded per-client request rates; rate-limited callback clears state', async (t) => {
  const { base } = await server(t);
  for (let i = 0; i < 10; i += 1) assert.equal((await fetch(`${base}/auth/google`, { redirect: 'manual' })).status, 302);
  const limitedStart = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  assert.equal(limitedStart.status, 429);
  assert.equal(limitedStart.headers.get('set-cookie'), clearCookie);
  assertSafeHeaders(limitedStart);

  for (let i = 0; i < 30; i += 1) {
    const response = await fetch(`${base}/auth/google/callback?error=denied`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${webOrigin}/login?status=oauth-failed`);
  }
  const limitedCallback = await fetch(`${base}/auth/google/callback?error=denied`, { redirect: 'manual' });
  assert.equal(limitedCallback.status, 429);
  assert.equal(limitedCallback.headers.get('set-cookie'), clearCookie);
  assertSafeHeaders(limitedCallback);
});
