const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IdentityStore, IdentityStoreError } = require('../../dist/auth/identity-store.js');
const ID = '123e4567-e89b-42d3-a456-426614174000';
const identity = { issuer: 'local', subject: ID };
function fixture(rows = [], error) {
  const calls = [];
  return { calls, store: new IdentityStore({ async query(sql, parameters) {
    calls.push({ sql, parameters }); if (error) throw error; return { rows };
  } }) };
}
test('retired provider admission never creates or links any account', async () => {
  const f = fixture([{ id: ID }]);
  for (const issuer of ['google', 'local', 'nousai']) await assert.rejects(f.store.getOrCreateOwner({ issuer, subject: ID }), IdentityStoreError);
  assert.deepEqual(f.calls, []);
});
test('findOwnerByIdentity binds local UUID identity and returns null only for absence', async () => {
  const f = fixture([{ id: ID }]);
  assert.equal(await f.store.findOwnerByIdentity(identity), ID);
  assert.deepEqual(f.calls[0].parameters, [ID]);
  assert.match(f.calls[0].sql, /WHERE issuer = 'local' AND subject = \$1 AND id::text = \$1/);
  assert.equal(await fixture().store.findOwnerByIdentity(identity), null);
});
test('unsupported issuer and unstable local subjects reject before querying', async () => {
  const f = fixture();
  for (const value of [null, {}, { issuer: 'nousai', subject: ID }, { issuer: 'local', subject: 'not-a-uuid' },
    ...['', 'has space', 'has\ncontrol', '\ud800', 'e\u0301', 'é'.repeat(257)].map(subject => ({ issuer: 'local', subject }))]) {
    await assert.rejects(f.store.findOwnerByIdentity(value), IdentityStoreError);
  }
  assert.deepEqual(f.calls, []);
});
test('historical migration remains immutable and 011 replaces only its issuer constraint', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '../../db/migrations', name), 'utf8');
  assert.match(read('001_owner_identity.sql'), /CHECK \(issuer = 'google'\)/);
  assert.doesNotMatch(read('001_owner_identity.sql'), /CREATE TABLE IF NOT EXISTS/);
  assert.match(read('011_roles_practices.sql'), /DROP CONSTRAINT lingualoop_accounts_google_issuer/);
});
test('malformed or ambiguous rows and database details fail generically', async () => {
  for (const rows of [[{ id: 'bad' }], [{ id: ID }, { id: ID }], [null], [{}], [{ id: '223e4567-e89b-42d3-a456-426614174000' }]]) {
    await assert.rejects(fixture(rows).store.findOwnerByIdentity(identity), IdentityStoreError);
  }
  await assert.rejects(fixture([], Error('PRIVATE SQL')).store.findOwnerByIdentity(identity), error => error.message === 'Identity store operation failed.');
});
