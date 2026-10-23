const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { LINGUALOOP_TOKEN_SIGNING_KEY } = require('../../dist/auth/lingualoop-token.service.js');
const { LINGUALOOP_QUERY_EXECUTOR } = require('../../dist/db/postgres.js');
const { LANGUAGE_PRACTICE_REPORT_SERVICE } = require('../../dist/language-practice/language-practice-session.providers.js');
const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const SESSION = '223e4567-e89b-42d3-a456-426614174000';
const origin = 'http://localhost:5001';
// Dedicated process environment: no inherited Google/media/provider paths or secret-file reads.
process.env = { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT, NODE_ENV: 'test', LINGUALOOP_WEB_ORIGIN: origin };
const { AppModule } = require('../../dist/app.module.js');

test('OAuth-only module rejects password login and preserves refresh, /me, logout and replay', async t => {
  const account = { id: OWNER, name: 'Student Name', email: 'student@example.test', role: 'student', created_at: new Date('2026-01-01') };
  let current;
  const spent = new Set();
  let expiry;
  let revoked = false;
  let accountReads = 0;
  const calls = [];
  const executor = { async withTransaction(callback) { return callback(this); }, async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('password_hash')) { accountReads++; return { rows: values[0] === account.email ? [account] : [] }; }
    if (sql.includes('INSERT INTO lingualoop_auth_sessions')) { expiry = values[1]; revoked = false; return { rows: [{ id: SESSION }] }; }
    if (sql.includes('SET current_refresh_hash')) { current = values[2]; return { rows: [{ id: SESSION }] }; }
    if (sql.includes('lingualoop_rotate_refresh')) {
      const [sid, hash, next] = values;
      if (sid !== SESSION || revoked) return { rows: [{ status: 'invalid' }] };
      if (spent.has(hash)) { revoked = true; return { rows: [{ status: 'replay' }] }; }
      if (hash !== current) return { rows: [{ status: 'invalid' }] };
      spent.add(hash); current = next;
      return { rows: [{ status: 'rotated', ownerId: OWNER, issuer: 'local', subject: OWNER, expiresAtMs: expiry }] };
    }
    if (sql.includes('SET revoked_at_ms')) { revoked = true; return { rows: [] }; }
    if (sql.includes('SELECT id FROM lingualoop_auth_sessions')) return { rows: revoked ? [] : [{ id: SESSION }] };
    if (sql.includes('SELECT name, email, role')) return { rows: [account] };
    if (sql.includes('SELECT id FROM lingualoop_accounts')) return { rows: [{ id: OWNER }] };
    return { rows: [] };
  } };
  const providers = Reflect.getMetadata('providers', AppModule).map(provider => {
    if (provider.provide === LINGUALOOP_QUERY_EXECUTOR) return { provide: provider.provide, useValue: executor };
    if (provider.provide === LINGUALOOP_TOKEN_SIGNING_KEY) return { provide: provider.provide, useValue: 'offline-production-signing-test-only-32-characters' };
    if (provider.provide === LANGUAGE_PRACTICE_REPORT_SERVICE) return { provide: provider.provide, useValue: { async getOrCreate() { throw Error('must not generate'); } } };
    return provider;
  });
  class OfflineModule {}
  Module({ controllers: Reflect.getMetadata('controllers', AppModule), providers })(OfflineModule);
  const app = await NestFactory.create(OfflineModule, { logger: false, abortOnError: false });
  t.after(() => app.close()); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  async function request(path, method = 'POST', body, headers = {}) {
    return fetch(base + path, { method, headers: { origin, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
  for (const path of ['/auth/google', '/auth/google/callback']) assert.equal((await request(path, 'GET')).status, 404);
  const input = { email: ' STUDENT@EXAMPLE.TEST ', password: ' exact password ' };
  for (const body of [input, {}, { ...input, role: 'admin' }]) {
    for (const origin of ['http://evil.test', 'http://localhost:5001']) {
      const response = await request('/auth/login', 'POST', body, { origin });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  }
  assert.equal(accountReads, 0);
  assert.deepEqual(await (await request('/auth/providers', 'GET')).json(), { google: false, microsoft: false });
  // Seed a session through an internal fixture, never through a public login endpoint.
  const { GoogleLoginSession } = require('../../dist/auth/google-login-session.js');
  const { GOOGLE_BROWSER_POLICY } = require('../../dist/auth/google-browser-policy.js');
  const stores = require('../../dist/auth/auth-store.providers.js');
  const { LinguaLoopTokenService } = require('../../dist/auth/lingualoop-token.service.js');
  const issuer = new GoogleLoginSession({
    googleIdentityService: { async verify() { return { issuer: 'google', subject: 'verified-fixture', email: account.email }; } },
    identityStore: { async linkExternalIdentity() { return OWNER; } },
    sessionStore: app.get(stores.LINGUALOOP_SESSION_STORE),
    refreshStore: app.get(stores.LINGUALOOP_REFRESH_STORE),
    tokenService: app.get(LinguaLoopTokenService),
  });
  async function seedSessionCookie() {
    const result = await issuer.issue('test-ticket');
    return app.get(GOOGLE_BROWSER_POLICY).refreshCookie(result.refreshCredential, result.expiresAtMs, Date.now()).split(';')[0];
  }
  const cookie = await seedSessionCookie();
  const refreshed = await request('/auth/refresh', 'POST', undefined, { cookie });
  assert.equal(refreshed.status, 200);
  const auth = await refreshed.json(); assert.deepEqual(Object.keys(auth), ['accessToken']);
  const rotatedCookie = refreshed.headers.get('set-cookie').split(';')[0];
  assert.notEqual(rotatedCookie, cookie);
  const me = await request('/auth/me', 'GET', undefined, { authorization: `Bearer ${auth.accessToken}`, 'x-role': 'admin' });
  assert.equal(me.status, 200); assert.deepEqual(await me.json(), { ownerId: OWNER, name: account.name, email: account.email, role: 'student' });
  assert.equal((await request('/language-practice/options', 'GET', undefined, { authorization: `Bearer ${auth.accessToken}` })).status, 200);
  assert.equal((await request('/auth/logout', 'POST', undefined, { authorization: `Bearer ${auth.accessToken}`, cookie: rotatedCookie, origin: 'http://evil.test' })).status, 403);
  assert.equal(revoked, false);
  assert.equal((await request('/auth/logout', 'POST', undefined, { authorization: `Bearer ${auth.accessToken}`, cookie: rotatedCookie })).status, 204);
  assert.equal(revoked, true);
  assert.equal((await request('/auth/me', 'GET', undefined, { authorization: `Bearer ${auth.accessToken}` })).status, 401);
  // New session proves old refresh reuse revokes after a successful rotation, not just logout.
  const secondCookie = await seedSessionCookie();
  assert.equal((await request('/auth/refresh', 'POST', undefined, { cookie: secondCookie })).status, 200);
  assert.equal((await request('/auth/refresh', 'POST', undefined, { cookie: secondCookie })).status, 401);
  assert.equal(revoked, true);
  assert.equal(calls.some(call => call.values.includes(input.password)), false);
});
