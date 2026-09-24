const test = require('node:test');
const assert = require('node:assert/strict');
const { NestFactory } = require('@nestjs/core');
const { Module } = require('@nestjs/common');
const { HealthController } = require('../dist/health.controller.js');
const { LINGUALOOP_QUERY_EXECUTOR } = require('../dist/db/postgres.js');
const { GoogleAuthController, GOOGLE_AUTH_RATE_LIMITER, GoogleAuthRateLimiter } = require('../dist/auth/google-auth.controller.js');
const { GOOGLE_AUTH_FLOW } = require('../dist/auth/google-auth.providers.js');
const { GoogleCodeExchange } = require('../dist/auth/google-code-exchange.js');

const state = 'A'.repeat(43);
const stateCookie = `lingualoop-oauth-state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`;
const clearCookie = 'lingualoop-oauth-state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
const refreshCookie = 'lingualoop-refresh=refresh-test; Path=/; HttpOnly; SameSite=Lax; Max-Age=600';

async function server(t, overrides = {}) {
  let consumed = false;
  const calls = [];
  const flow = {
    async begin() { calls.push('begin'); return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`, stateCookie }; },
    clearStateCookie() { return clearCookie; },
    async finish(input) {
      calls.push(input);
      if (consumed) throw new Error('replay');
      if (input.cookieHeader !== `lingualoop-oauth-state=${state}` || input.state !== state || input.code !== 'code') throw new Error('invalid');
      consumed = true;
      return { redirectUrl: 'http://localhost:5001', refreshCookie, stateCookie: clearCookie };
    },
    ...overrides,
  };
  class TestModule {}
  const app = await NestFactory.create({
    module: TestModule,
    controllers: [GoogleAuthController],
    providers: [
      { provide: GOOGLE_AUTH_FLOW, useValue: flow },
      { provide: GOOGLE_AUTH_RATE_LIMITER, useValue: new GoogleAuthRateLimiter() },
    ],
  }, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address();
  return { base: `http://127.0.0.1:${address.port}`, calls };
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
    'GOOGLE_CLIENT_SECRET', 'LINGUALOOP_GOOGLE_AUDIENCE', 'LINGUALOOP_TOKEN_SIGNING_KEY', 'LINGUALOOP_TOKEN_SIGNING_KEY_FILE',
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
    controllers: appControllers,
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
});

test('malformed present Google settings keep health routes live and disable auth routes', async (t) => {
  const names = [
    'GOOGLE_CALLBACK_URL', 'LINGUALOOP_WEB_ORIGIN', 'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 'LINGUALOOP_GOOGLE_AUDIENCE', 'LINGUALOOP_TOKEN_SIGNING_KEY', 'LINGUALOOP_TOKEN_SIGNING_KEY_FILE',
  ];
  const valid = {
    GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback',
    LINGUALOOP_WEB_ORIGIN: 'http://localhost:5001',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    LINGUALOOP_GOOGLE_AUDIENCE: 'client-id.apps.googleusercontent.com',
    LINGUALOOP_TOKEN_SIGNING_KEY: 'a'.repeat(32),
  };
  const malformed = [
    { ...valid, GOOGLE_CALLBACK_URL: 'not a URL' },
    { ...valid, LINGUALOOP_WEB_ORIGIN: 'http://127.0.0.1:5001' },
    { ...valid, GOOGLE_CLIENT_ID: ' contains whitespace ' },
    { ...valid, GOOGLE_CLIENT_SECRET: '   ' },
    { ...valid, LINGUALOOP_GOOGLE_AUDIENCE: '   ' },
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
    controllers: appControllers,
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
});

test('fully valid Google settings continue to register auth routes and providers', () => {
  const names = [
    'GOOGLE_CALLBACK_URL', 'LINGUALOOP_WEB_ORIGIN', 'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 'LINGUALOOP_GOOGLE_AUDIENCE', 'LINGUALOOP_TOKEN_SIGNING_KEY', 'LINGUALOOP_TOKEN_SIGNING_KEY_FILE',
  ];
  const settings = {
    GOOGLE_CALLBACK_URL: 'http://localhost:5000/auth/google/callback',
    LINGUALOOP_WEB_ORIGIN: 'http://localhost:5001',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    LINGUALOOP_GOOGLE_AUDIENCE: 'client-id.apps.googleusercontent.com',
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

test('callback errors and replay are generic and always clear state cookie', async (t) => {
  const { base } = await server(t);
  const url = `${base}/auth/google/callback?code=code&state=${state}`;
  const headers = { cookie: `lingualoop-oauth-state=${state}` };
  const first = await fetch(url, { headers, redirect: 'manual' });
  assert.equal(first.status, 302);
  const replay = await fetch(url, { headers, redirect: 'manual' });
  assert.equal(replay.status, 400);
  assert.equal(replay.headers.get('set-cookie'), clearCookie);
  assert.equal(await replay.text(), 'Google login could not be completed.');
  assertSafeHeaders(replay);

  const invalid = await fetch(`${base}/auth/google/callback?error=access_denied`, { redirect: 'manual' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('set-cookie'), clearCookie);
  assert.equal(await invalid.text(), 'Google login could not be completed.');
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
    assert.equal(response.status, 400);
  }
  const limitedCallback = await fetch(`${base}/auth/google/callback?error=denied`, { redirect: 'manual' });
  assert.equal(limitedCallback.status, 429);
  assert.equal(limitedCallback.headers.get('set-cookie'), clearCookie);
  assertSafeHeaders(limitedCallback);
});
