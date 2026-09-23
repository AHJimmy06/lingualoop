const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SessionStore, SessionStoreError } = require('../../dist/auth/session-store.js');

const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_OWNER = '223e4567-e89b-42d3-a456-426614174000';
const SESSION = '323e4567-e89b-42d3-a456-426614174000';

function fakeQuery(results = [], error = null) {
  const calls = [];
  let index = 0;
  return {
    calls,
    store: new SessionStore({
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        if (error) throw error;
        return results[index++] ?? { rows: [] };
      },
    }),
  };
}

test('createSession uses DB-generated UUID, bound owner/expiry, and validates the returned UUID', async () => {
  const fake = fakeQuery([{ rows: [{ id: SESSION }] }]);
  assert.equal(await fake.store.createSession(OWNER, 9000), SESSION);
  assert.match(fake.calls[0].sql, /INSERT INTO lingualoop_auth_sessions/i);
  assert.match(fake.calls[0].sql, /RETURNING id/i);
  assert.deepEqual(fake.calls[0].parameters, [OWNER, 9000]);
  assert.ok(!fake.calls[0].sql.includes(OWNER));
  for (const rows of [[], [{ id: 'bad' }], [{ id: SESSION }, { id: SESSION }], [null], [{}]]) {
    await assert.rejects(fakeQuery([{ rows }]).store.createSession(OWNER, 9000), SessionStoreError);
  }
});

test('active lookup scopes by owner and UUID, checks expiry and revocation in SQL', async () => {
  const fake = fakeQuery([{ rows: [{ id: SESSION }] }]);
  assert.equal(await fake.store.isSessionActive(OWNER, SESSION, 5000), true);
  const call = fake.calls[0];
  assert.match(call.sql, /WHERE owner_id = \$1 AND id = \$2 AND expires_at_ms > \$3 AND revoked_at_ms IS NULL/i);
  assert.deepEqual(call.parameters, [OWNER, SESSION, 5000]);
  assert.equal(await fake.store.isSessionActive(OTHER_OWNER, SESSION, 5000), false);
  assert.deepEqual(fake.calls[1].parameters, [OTHER_OWNER, SESSION, 5000]);
  assert.equal(await fakeQuery([{ rows: [] }]).store.isSessionActive(OWNER, SESSION, 9000), false);
  assert.equal(await fakeQuery([{ rows: [] }]).store.isSessionActive(OWNER, SESSION, 9001), false);
});

test('unknown or stolen UUID is inactive and invalid active rows fail generically', async () => {
  assert.equal(await fakeQuery([{ rows: [] }]).store.isSessionActive(OWNER, SESSION, 5000), false);
  for (const rows of [[null], [{}], [{ id: 'bad' }], [{ id: OTHER_OWNER }], [{ id: SESSION }, { id: SESSION }]]) {
    await assert.rejects(fakeQuery([{ rows }]).store.isSessionActive(OWNER, SESSION, 5000), SessionStoreError);
  }
});

test('revoke is idempotent and always scoped by owner and session id', async () => {
  const fake = fakeQuery([{ rows: [] }]);
  await fake.store.revokeSession(OWNER, SESSION, 6000);
  const call = fake.calls[0];
  assert.match(call.sql, /UPDATE lingualoop_auth_sessions/i);
  assert.match(call.sql, /WHERE owner_id = \$1 AND id = \$2 AND revoked_at_ms IS NULL/i);
  assert.deepEqual(call.parameters, [OWNER, SESSION, 6000]);
  await fake.store.revokeSession(OWNER, SESSION, 7000);
  assert.equal(fake.calls.length, 2);
});

test('invalid UUIDs and unsafe/non-positive timestamps reject before querying', async () => {
  const fake = fakeQuery();
  for (const args of [
    ['bad', SESSION, 1], [OWNER, 'bad', 1], [OWNER, SESSION, 0], [OWNER, SESSION, -1],
    [OWNER, SESSION, Number.MAX_SAFE_INTEGER + 1], [OWNER, SESSION, '1'],
  ]) await assert.rejects(fake.store.isSessionActive(...args), SessionStoreError);
  await assert.rejects(fake.store.createSession(OWNER, Number.MAX_SAFE_INTEGER + 1), SessionStoreError);
  assert.equal(fake.calls.length, 0);
});

test('database errors are sanitized for every operation', async () => {
  const secret = 'database-secret-detail';
  for (const invoke of [
    (store) => store.createSession(OWNER, 9000),
    (store) => store.isSessionActive(OWNER, SESSION, 5000),
    (store) => store.revokeSession(OWNER, SESSION, 5000),
  ]) await assert.rejects(invoke(fakeQuery([], new Error(secret)).store), (error) => {
    assert.equal(error.name, 'SessionStoreError');
    assert.equal(error.message, 'Session store operation failed.');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('migration uses independent accounts FK, DB UUID, expiry constraints, and owner/expiry index', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/003_auth_sessions.sql'), 'utf8');
  assert.match(sql, /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
  assert.match(sql, /owner_id UUID NOT NULL REFERENCES lingualoop_accounts\(id\)/i);
  assert.match(sql, /expires_at_ms BIGINT NOT NULL CHECK \(expires_at_ms > 0\)/i);
  assert.match(sql, /revoked_at_ms BIGINT CHECK \(revoked_at_ms IS NULL OR revoked_at_ms > 0\)/i);
  assert.match(sql, /\(owner_id, expires_at_ms\)/i);
  assert.doesNotMatch(sql, /\bUser\b|JWT|secret|refresh_token/i);
});
