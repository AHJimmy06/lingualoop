const test = require('node:test');
const assert = require('node:assert/strict');
const { IdentityStore, IdentityStoreError } = require('../../dist/auth/identity-store.js');
const identity = { issuer: 'google', subject: 'verified-subject', email: 'approved@example.test' };
test('retired Google admission rejects even an approved identity without reading or mutating stores', async () => {
  let calls = 0;
  const store = new IdentityStore({ async query() { calls++; throw Error('must not query'); }, async withTransaction() { calls++; throw Error('must not transact'); } });
  for (const value of [identity, { ...identity, email: undefined }, { ...identity, subject: 'historical-bound-subject' }]) {
    await assert.rejects(store.getOrCreateOwner(value), IdentityStoreError);
  }
  assert.equal(calls, 0);
});
