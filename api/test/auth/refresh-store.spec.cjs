const test = require('node:test');
const assert = require('node:assert/strict');
const { RefreshStore, RefreshStoreError } = require('../../dist/auth/refresh-store.js');

const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const SESSION = '323e4567-e89b-42d3-a456-426614174000';
const HASH = 'a'.repeat(64);
const NEXT = 'b'.repeat(64);

function fakeQuery(results = [], error = null) {
  const calls = [];
  let index = 0;
  return {
    calls,
    store: new RefreshStore({
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        if (error) throw error;
        return results[index++] ?? { rows: [] };
      },
    }),
  };
}

test('initialize binds owner/session/hash/time and only succeeds for returned matching session', async () => {
  const fake = fakeQuery([{ rows: [{ id: SESSION }] }]);
  assert.equal(await fake.store.initialize(OWNER, SESSION, HASH, 5000), true);
  assert.match(fake.calls[0].sql, /UPDATE lingualoop_auth_sessions/i);
  assert.match(fake.calls[0].sql, /owner_id = \$1 AND id = \$2 AND expires_at_ms > \$4/i);
  assert.match(fake.calls[0].sql, /revoked_at_ms IS NULL AND current_refresh_hash IS NULL/i);
  assert.deepEqual(fake.calls[0].parameters, [OWNER, SESSION, HASH, 5000]);
  assert.equal(await fakeQuery([{ rows: [] }]).store.initialize(OWNER, SESSION, HASH, 5000), false);
  await assert.rejects(fakeQuery([{ rows: [{ id: OWNER }] }]).store.initialize(OWNER, SESSION, HASH, 5000), RefreshStoreError);
});

test('rotation delegates one atomic DB operation and validates rotated owner identity and unchanged expiry', async () => {
  const fake = fakeQuery([{ rows: [{ status: 'rotated', ownerId: OWNER, issuer: 'google', subject: 'google-subject', expiresAtMs: 9000 }] }]);
  assert.deepEqual(await fake.store.rotate(SESSION, HASH, NEXT, 5000), {
    status: 'rotated', ownerId: OWNER, issuer: 'google', subject: 'google-subject', expiresAtMs: 9000,
  });
  const call = fake.calls[0];
  assert.match(call.sql, /FROM lingualoop_rotate_refresh\(\$1, \$2, \$3, \$4\)/i);
  assert.deepEqual(call.parameters, [SESSION, HASH, NEXT, 5000]);
  assert.ok(!call.sql.includes(HASH));
  const pgExpiry = '1700000000000';
  const pgResult = fakeQuery([{ rows: [{ status: 'rotated', ownerId: OWNER, issuer: 'google', subject: 'google-subject', expiresAtMs: pgExpiry }] }]);
  assert.deepEqual(await pgResult.store.rotate(SESSION, HASH, NEXT, 1699999999000), {
    status: 'rotated', ownerId: OWNER, issuer: 'google', subject: 'google-subject', expiresAtMs: 1700000000000,
  });
  for (const bad of [
    { status: 'rotated', ownerId: 'bad', issuer: 'google', subject: 'x', expiresAtMs: 9000 },
    { status: 'rotated', ownerId: OWNER, issuer: 'other', subject: 'x', expiresAtMs: 9000 },
    { status: 'rotated', ownerId: OWNER, issuer: 'google', subject: 'x', expiresAtMs: 5000 },
    { status: 'rotated', ownerId: OWNER, issuer: 'google', subject: '', expiresAtMs: 9000 },
    { status: 'rotated', ownerId: OWNER, issuer: 'google', subject: 'e\u0301', expiresAtMs: 9000 },
    { status: 'rotated', ownerId: OWNER, issuer: 'google', subject: '\ud800', expiresAtMs: 9000 },
    ...['9007199254740992', '1700000000000.5', '1700000000000x'].map((expiresAtMs) =>
      ({ status: 'rotated', ownerId: OWNER, issuer: 'google', subject: 'x', expiresAtMs })),
  ]) await assert.rejects(fakeQuery([{ rows: [bad] }]).store.rotate(SESSION, HASH, NEXT, 5000), RefreshStoreError);
});

test('spent replay and arbitrary invalid hash are redacted and expose no identity', async () => {
  for (const status of ['replay', 'invalid']) {
    const fake = fakeQuery([{ rows: [{ status, ownerId: null, issuer: null, subject: null, expiresAtMs: null }] }]);
    assert.deepEqual(await fake.store.rotate(SESSION, HASH, NEXT, 5000), { status });
    assert.deepEqual(fake.calls[0].parameters, [SESSION, HASH, NEXT, 5000]);
  }
  await assert.rejects(fakeQuery([{ rows: [{ status: 'invalid', ownerId: OWNER }] }]).store.rotate(SESSION, HASH, NEXT, 5000), RefreshStoreError);
});

test('invalid or mismatched inputs reject before query, and failures are generic', async () => {
  const fake = fakeQuery();
  for (const args of [
    ['bad', SESSION, HASH, 5000], [OWNER, 'bad', HASH, 5000], [OWNER, SESSION, 'A'.repeat(64), 5000],
    [OWNER, SESSION, HASH, 0],
  ]) await assert.rejects(fake.store.initialize(...args), RefreshStoreError);
  for (const args of [
    ['bad', HASH, NEXT, 5000], [SESSION, 'bad', NEXT, 5000], [SESSION, HASH, HASH, 5000],
    [SESSION, HASH, NEXT, Number.MAX_SAFE_INTEGER + 1],
  ]) await assert.rejects(fake.store.rotate(...args), RefreshStoreError);
  assert.equal(fake.calls.length, 0);
  await assert.rejects(fakeQuery([], new Error('private database detail')).store.rotate(SESSION, HASH, NEXT, 5000),
    (error) => error.name === 'RefreshStoreError' && error.message === 'Refresh store operation failed.' && !error.message.includes('private'));
});
