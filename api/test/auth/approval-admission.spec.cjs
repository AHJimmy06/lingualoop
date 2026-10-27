const test = require('node:test');
const assert = require('node:assert/strict');
const { IdentityStore, IdentityStoreError } = require('../../dist/auth/identity-store.js');
const identity = { issuer: 'google', subject: 'verified-subject', email: 'approved@example.test' };

test('OAuth admission fails closed when registration storage is unavailable', async () => {
  let calls = 0;
  const store = new IdentityStore({ async query() { throw Error('must transact'); }, async withTransaction() { calls++; throw Error('private database failure'); } });
  for (const value of [identity, { ...identity, subject: 'historical-bound-subject' }]) {
    await assert.rejects(store.getOrCreateOwner(value), error => error instanceof IdentityStoreError && !error.message.includes('private'));
  }
  assert.equal(calls, 2);
  await assert.rejects(store.getOrCreateOwner({ ...identity, email: undefined }), IdentityStoreError);
  assert.equal(calls, 2, 'unverified input must not enter registration');
});
