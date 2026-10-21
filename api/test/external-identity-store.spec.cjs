const test = require('node:test');
const assert = require('node:assert/strict');
const { IdentityStore, IdentityStoreError } = require('../dist/auth/identity-store.js');

const accountId = '550e8400-e29b-41d4-a716-446655440000';

test('links Google and Microsoft identities only to an existing admin-provisioned account', async () => {
  const identities = new Map();
  const executor = {
    async query(sql, values) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('lingualoop_external_identities') && sql.includes('SELECT account_id')) {
        const owner = identities.get(`${values[0]}:${values[1]}`);
        if (sql.includes('AS id')) return { rows: owner ? [{ id: owner }] : [] };
        return { rows: owner ? [{ account_id: owner }] : [] };
      }
      if (sql.includes('FROM lingualoop_accounts WHERE email')) return { rows: [{ id: accountId }] };
      if (sql.includes('INSERT INTO lingualoop_external_identities')) {
        const key = `${values[1]}:${values[2]}`;
        if (identities.has(key)) return { rows: [] };
        identities.set(key, values[0]); return { rows: [{ account_id: values[0] }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async withTransaction(callback) { return callback(this); },
  };
  const store = new IdentityStore(executor);
  assert.equal(await store.linkExternalIdentity({ issuer: 'google', subject: 'g-sub', email: 'student@example.org' }), accountId);
  assert.equal(await store.linkExternalIdentity({ issuer: 'microsoft', subject: 'm-sub', email: 'student@example.org' }), accountId);
  assert.equal(await store.findOwnerByIdentity({ issuer: 'google', subject: 'g-sub' }), accountId);
  assert.equal(await store.findOwnerByIdentity({ issuer: 'microsoft', subject: 'm-sub' }), accountId);
});

test('rejects unsupported issuer or an email that does not map to a provisioned account', async () => {
  const executor = {
    async query(sql) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT account_id')) return { rows: [] };
      if (sql.includes('FROM lingualoop_accounts')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    async withTransaction(callback) { return callback(this); },
  };
  const store = new IdentityStore(executor);
  await assert.rejects(store.linkExternalIdentity({ issuer: 'google', subject: 'unknown', email: 'nobody@example.org' }), IdentityStoreError);
  await assert.rejects(store.linkExternalIdentity({ issuer: 'other', subject: 'unknown', email: 'nobody@example.org' }), IdentityStoreError);
});
