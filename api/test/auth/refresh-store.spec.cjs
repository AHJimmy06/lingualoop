const test = require('node:test');
const assert = require('node:assert/strict');
const { RefreshStore, RefreshStoreError } = require('../../dist/auth/refresh-store.js');
const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const SESSION = '323e4567-e89b-42d3-a456-426614174000';
const HASH = 'a'.repeat(64);
const NEXT = 'b'.repeat(64);
function fakeQuery(results = [], error) {
  const calls = [];
  let index = 0;
  return { calls, store: new RefreshStore({ async query(sql, parameters) { calls.push({ sql, parameters }); if (error) throw error; return results[index++] ?? { rows: [] }; } }) };
}
test('initialize binds owner/session/hash/time and validates returned matching session', async () => {
  const f = fakeQuery([{ rows: [{ id: SESSION }] }]);
  assert.equal(await f.store.initialize(OWNER, SESSION, HASH, 5000), true);
  assert.match(f.calls[0].sql, /owner_id = \$1 AND id = \$2 AND expires_at_ms > \$4/);
  assert.match(f.calls[0].sql, /revoked_at_ms IS NULL AND current_refresh_hash IS NULL/);
  assert.deepEqual(f.calls[0].parameters, [OWNER, SESSION, HASH, 5000]);
  assert.equal(await fakeQuery([{ rows: [] }]).store.initialize(OWNER, SESSION, HASH, 5000), false);
  await assert.rejects(fakeQuery([{ rows: [{ id: OWNER }] }]).store.initialize(OWNER, SESSION, HASH, 5000), RefreshStoreError);
});
test('rotation uses applied atomic SQL, accepts only local owner UUID identity and unchanged expiry', async () => {
  const row = { status: 'rotated', ownerId: OWNER, issuer: 'local', subject: OWNER, expiresAtMs: 9000 };
  const f = fakeQuery([{ rows: [row] }]);
  assert.deepEqual(await f.store.rotate(SESSION, HASH, NEXT, 5000), row);
  assert.match(f.calls[0].sql, /FROM lingualoop_rotate_refresh\(\$1, \$2, \$3, \$4\)/);
  assert.deepEqual(f.calls[0].parameters, [SESSION, HASH, NEXT, 5000]);
  assert.ok(!f.calls[0].sql.includes(HASH));
  assert.deepEqual(await fakeQuery([{ rows: [{ ...row, expiresAtMs: '1700000000000' }] }]).store.rotate(SESSION, HASH, NEXT, 5000), { ...row, expiresAtMs: 1700000000000 });
  for (const bad of [{ ...row, ownerId: 'bad' }, { ...row, issuer: 'google' }, { ...row, issuer: 'other' }, { ...row, subject: SESSION },
    ...['', 'x', 'e\u0301', '\ud800'].map(subject => ({ ...row, subject })),
    ...[5000, '9007199254740992', '1700000000000.5', '1700000000000x'].map(expiresAtMs => ({ ...row, expiresAtMs }))]) {
    await assert.rejects(fakeQuery([{ rows: [bad] }]).store.rotate(SESSION, HASH, NEXT, 5000), RefreshStoreError);
  }
});
test('spent replay and invalid hash return redacted identities', async () => {
  for (const status of ['replay', 'invalid']) assert.deepEqual(await fakeQuery([{ rows: [{ status, ownerId: null, issuer: null, subject: null, expiresAtMs: null }] }]).store.rotate(SESSION, HASH, NEXT, 5000), { status });
  await assert.rejects(fakeQuery([{ rows: [{ status: 'invalid', ownerId: OWNER }] }]).store.rotate(SESSION, HASH, NEXT, 5000), RefreshStoreError);
});
test('invalid inputs reject before SQL and database failures are sanitized', async () => {
  const f = fakeQuery();
  for (const args of [['bad', SESSION, HASH, 5000], [OWNER, 'bad', HASH, 5000], [OWNER, SESSION, 'A'.repeat(64), 5000], [OWNER, SESSION, HASH, 0]]) await assert.rejects(f.store.initialize(...args), RefreshStoreError);
  for (const args of [['bad', HASH, NEXT, 5000], [SESSION, 'bad', NEXT, 5000], [SESSION, HASH, HASH, 5000], [SESSION, HASH, NEXT, Number.MAX_SAFE_INTEGER + 1]]) await assert.rejects(f.store.rotate(...args), RefreshStoreError);
  assert.deepEqual(f.calls, []);
  await assert.rejects(fakeQuery([], Error('PRIVATE')).store.rotate(SESSION, HASH, NEXT, 5000), error => error.message === 'Refresh store operation failed.');
});
