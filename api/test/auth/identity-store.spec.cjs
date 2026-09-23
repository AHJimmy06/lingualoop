const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IdentityStore, IdentityStoreError } = require('../../dist/auth/identity-store.js');

const ID = '123e4567-e89b-42d3-a456-426614174000';
const identity = { issuer: 'google', subject: 'provider-user-1' };

function fakeQuery(result, error) {
  const calls = [];
  return {
    calls,
    store: new IdentityStore({
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        if (error) throw error;
        return result;
      },
    }),
  };
}

test('getOrCreateOwner uses atomic conflict-safe SQL and binds identity parameters', async () => {
  const fake = fakeQuery({ rows: [{ id: ID }] });
  assert.equal(await fake.store.getOrCreateOwner(identity), ID);
  assert.match(fake.calls[0].sql, /INSERT INTO lingualoop_accounts/i);
  assert.match(fake.calls[0].sql, /ON CONFLICT \(issuer, subject\) DO UPDATE/i);
  assert.match(fake.calls[0].sql, /RETURNING id/i);
  assert.deepEqual(fake.calls[0].parameters, ['google', 'provider-user-1']);
  assert.ok(!fake.calls[0].sql.includes('provider-user-1'));
});

test('findOwnerByIdentity is scoped by both identity fields and returns null when absent', async () => {
  const fake = fakeQuery({ rows: [] });
  assert.equal(await fake.store.findOwnerByIdentity(identity), null);
  assert.match(fake.calls[0].sql, /WHERE issuer = \$1 AND subject = \$2/i);
  assert.deepEqual(fake.calls[0].parameters, ['google', 'provider-user-1']);
  assert.doesNotMatch(fake.calls[0].sql, /SELECT\s+id\s+FROM\s+lingualoop_accounts\s*$/i);
});

test('invalid issuer and subject forms reject before querying', async () => {
  const fake = fakeQuery({ rows: [{ id: ID }] });
  const invalid = [
    { issuer: 'nousai', subject: 'legacy-user-id' },
    { issuer: 'microsoft', subject: 'provider-user' },
    { issuer: 'provider name', subject: 'ok' },
    { issuer: 'x'.repeat(65), subject: 'ok' },
    { issuer: 'google', subject: '' },
    { issuer: 'google', subject: 'has space' },
    { issuer: 'google', subject: 'has\ncontrol' },
    { issuer: 'google', subject: '\ud800' },
    { issuer: 'google', subject: 'e\u0301' },
    { issuer: 'google', subject: 'é'.repeat(257) },
    null,
  ];
  for (const value of invalid) await assert.rejects(fake.store.getOrCreateOwner(value), IdentityStoreError);
  assert.equal(fake.calls.length, 0);
});

test('migration fails loudly on table collisions and constrains the verified Google identity', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/001_owner_identity.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE lingualoop_accounts/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS/i);
  assert.match(migration, /CHECK \(issuer = 'google'\)/i);
  assert.match(migration, /CHECK \(octet_length\(subject\) BETWEEN 1 AND 512\)/i);
});

test('database failure is replaced with a generic error without leaking SQL or subject', async () => {
  const secretSubject = 'private-subject-value';
  const fake = fakeQuery(null, new Error(`SQL failed for ${secretSubject}`));
  await assert.rejects(fake.store.getOrCreateOwner({ issuer: 'google', subject: secretSubject }), (error) => {
    assert.equal(error.name, 'IdentityStoreError');
    assert.equal(error.message, 'Identity store operation failed.');
    assert.equal(error.message.includes(secretSubject), false);
    assert.equal(error.message.includes('SQL'), false);
    return true;
  });
});

test('malformed or ambiguous returned rows fail generically', async () => {
  for (const rows of [[], [{ id: 'not-a-uuid' }], [{ id: ID }, { id: ID }], [null], [{}]]) {
    const fake = fakeQuery({ rows });
    await assert.rejects(fake.store.getOrCreateOwner(identity), IdentityStoreError);
  }
  const noMatch = fakeQuery({ rows: [] });
  assert.equal(await noMatch.store.findOwnerByIdentity(identity), null);
  const badLookup = fakeQuery({ rows: [{ id: 'legacy-id' }] });
  await assert.rejects(badLookup.store.findOwnerByIdentity(identity), IdentityStoreError);
});
