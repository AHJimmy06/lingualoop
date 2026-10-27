const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { AdminAccountsController, CurrentAccountController } = require('../dist/auth/accounts.controller.js');
const { ConfiguredVerifiedRequestGuard } = require('../dist/auth/google-auth.providers.js');
const { RoleGuard, Roles } = require('../dist/auth/role.guard.js');
const { LinguaLoopTokenService } = require('../dist/auth/lingualoop-token.service.js');
const { AccountStore, LINGUALOOP_ACCOUNT_STORE } = require('../dist/auth/account-store.js');
const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../dist/auth/auth-store.providers.js');
const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const SESSION = '223e4567-e89b-42d3-a456-426614174000';
test('HTTP current-account and admin contracts use persisted authority and return no hashes or linked flags', async t => {
  const rows = [];
  let role = 'admin';
  let unavailable = false;
  const store = new AccountStore({ async query(sql, values) {
    if (unavailable) throw Error('PRIVATE');
    if (sql.includes('INSERT')) {
      if (rows.some(row => row.email === values[0])) return { rows: [] };
      const row = { id: values[2], name: null, email: values[0], role: values[1], created_at: new Date('2026-01-01') };
      rows.push(row); return { rows: [row] };
    }
    return { rows };
  } });
  const tokens = new LinguaLoopTokenService(new JwtService({}), 'offline-test-only-signing-key-32-characters');
  const token = await tokens.issue({ issuer: 'local', subject: OWNER, sessionId: SESSION });
  class OfflineModule {}
  Module({ controllers: [AdminAccountsController, CurrentAccountController], providers: [ConfiguredVerifiedRequestGuard, RoleGuard,
    { provide: LinguaLoopTokenService, useValue: tokens },
    { provide: LINGUALOOP_IDENTITY_STORE, useValue: { async findOwnerByIdentity() { return OWNER; }, async findAccountByOwner() { return role ? { name: 'Persisted Name', email: 'admin@example.test', role } : null; } } },
    { provide: LINGUALOOP_SESSION_STORE, useValue: { async isSessionActive() { return true; } } },
    { provide: LINGUALOOP_ACCOUNT_STORE, useValue: store },
  ] })(OfflineModule);
  const app = await NestFactory.create(OfflineModule, { logger: false, abortOnError: false });
  t.after(() => app.close()); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  async function request(path, method = 'GET', body, bearer = token) {
    const response = await fetch(base + path, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-role': 'admin' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  for (const bearer of [null, 'bad']) assert.equal((await request('/auth/me', 'GET', undefined, bearer)).status, 401);
  for (const next of ['admin', 'teacher', 'student']) {
    role = next;
    assert.deepEqual((await request('/auth/me')).body, { ownerId: OWNER, name: 'Persisted Name', email: 'admin@example.test', role });
    if (role !== 'admin') for (const method of ['GET', 'POST']) assert.equal((await request('/admin/accounts', method, method === 'POST' ? {} : undefined)).status, 403);
  }
  role = null; assert.equal((await request('/auth/me')).status, 403); role = 'admin';
  const input = { email: '  Person+Class@Example.Test ', role: 'teacher' };
  for (const invalid of [null, [], {}, { ...input, role: 'admin' }, { ...input, linked: true }, { ...input, name: ' ' }, { ...input, name: 'x'.repeat(121) }, { ...input, password: 'short' }, { ...input, password: 'x'.repeat(129) }, { ...input, email: 'é@example.test' }]) assert.equal((await request('/admin/accounts', 'POST', invalid)).status, 400);
  const created = await request('/admin/accounts', 'POST', input);
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body).sort(), ['createdAt', 'email', 'id', 'name', 'role']);
  assert.equal(created.body.email, 'person+class@example.test');
  assert.equal((await request('/admin/accounts', 'POST', { ...input, role: 'student' })).status, 409);
  assert.deepEqual((await request('/admin/accounts')).body, { accounts: [created.body] });
  unavailable = true;
  for (const method of ['GET', 'POST']) {
    const result = await request('/admin/accounts', method, method === 'POST' ? input : undefined);
    assert.equal(result.status, 503); assert.equal(JSON.stringify(result.body).includes('PRIVATE'), false);
  }
});
test('role policy has no admin override and fails closed without declared policy', () => {
  class Policy {}
  const guard = new RoleGuard(new Reflector());
  const context = role => ({ getHandler: () => function handler() {}, getClass: () => Policy, switchToHttp: () => ({ getRequest: () => ({ verifiedIdentity: role ? { role } : undefined }) }) });
  for (const required of ['student', 'teacher']) {
    Roles(required)(Policy); assert.equal(guard.canActivate(context(required)), true);
    for (const role of ['admin', 'teacher', 'student'].filter(role => role !== required)) assert.throws(() => guard.canActivate(context(role)), { status: 403 });
  }
  assert.throws(() => guard.canActivate(context(null)), { status: 401 });
  class NoPolicy {}
  const missing = context('admin'); missing.getClass = () => NoPolicy;
  assert.throws(() => guard.canActivate(missing), { status: 403 });
});
