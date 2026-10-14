const test = require('node:test');
const assert = require('node:assert/strict');
const { AppModule } = require('../../dist/app.module.js');
const { LINGUALOOP_QUERY_EXECUTOR } = require('../../dist/db/postgres.js');
const {
  LINGUALOOP_IDENTITY_STORE,
  LINGUALOOP_OAUTH_STATE_STORE,
  LINGUALOOP_SESSION_STORE,
  LINGUALOOP_REFRESH_STORE,
} = require('../../dist/auth/auth-store.providers.js');
const { IdentityStore } = require('../../dist/auth/identity-store.js');
const { AccountStore, LINGUALOOP_ACCOUNT_STORE } = require('../../dist/auth/account-store.js');
const { SessionStore } = require('../../dist/auth/session-store.js');
const { RefreshStore } = require('../../dist/auth/refresh-store.js');

const STORE_TYPES = new Map([
  [LINGUALOOP_IDENTITY_STORE, IdentityStore],
  [LINGUALOOP_ACCOUNT_STORE, AccountStore],
  [LINGUALOOP_SESSION_STORE, SessionStore],
  [LINGUALOOP_REFRESH_STORE, RefreshStore],
]);

test('Nest composes all auth stores from its one shared executor without startup I/O', async () => {
  const providers = Reflect.getMetadata('providers', AppModule);
  assert.ok(Array.isArray(providers));
  const executorProvider = providers.find((provider) => provider && provider.provide === LINGUALOOP_QUERY_EXECUTOR);
  assert.ok(executorProvider);

  const calls = [];
  const executor = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [] };
    },
  };
  const instances = new Map();
  for (const [token, StoreType] of STORE_TYPES) {
    const provider = providers.find((candidate) => candidate && candidate.provide === token);
    assert.ok(provider, `missing provider ${String(token)}`);
    assert.deepEqual(provider.inject, [LINGUALOOP_QUERY_EXECUTOR]);
    assert.equal(typeof provider.useFactory, 'function');
    const store = provider.useFactory(executor);
    assert.ok(store instanceof StoreType);
    assert.equal(store.executor, executor);
    instances.set(token, store);
  }

  assert.equal(calls.length, 0, 'constructing auth stores must not query PostgreSQL');
  assert.equal(providers.some(provider => provider.provide === LINGUALOOP_OAUTH_STATE_STORE), false, 'no active OAuth state dependency');
  await instances.get(LINGUALOOP_IDENTITY_STORE).findOwnerByIdentity({ issuer: 'local', subject: '123e4567-e89b-42d3-a456-426614174000' });
  await instances.get(LINGUALOOP_ACCOUNT_STORE).list();
  await instances.get(LINGUALOOP_SESSION_STORE).revokeSession('123e4567-e89b-42d3-a456-426614174000', '123e4567-e89b-42d3-a456-426614174000', 1);
  assert.equal(await instances.get(LINGUALOOP_REFRESH_STORE).initialize(
    '123e4567-e89b-42d3-a456-426614174000',
    '123e4567-e89b-42d3-a456-426614174000',
    'b'.repeat(64),
    1,
  ), false);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ sql }) => typeof sql === 'string' && sql.length > 0));
});
