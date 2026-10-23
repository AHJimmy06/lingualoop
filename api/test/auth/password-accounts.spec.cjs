const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, validatePassword } = require('../../dist/auth/password-hash.js');
const { AccountStore, DuplicateAccountError } = require('../../dist/auth/account-store.js');
const { IdentityStore } = require('../../dist/auth/identity-store.js');
const ID = '123e4567-e89b-42d3-a456-426614174000';
const input = { name: 'Person', email: ' Person@Example.Test ', password: ' exact password ', role: 'teacher' };
test('async salted bounded scrypt preserves password bytes and fails closed on malformed hashes', async () => {
  const hash = await hashPassword(input.password);
  assert.notEqual(hash, await hashPassword(input.password));
  assert.equal(await verifyPassword(input.password, hash), true);
  assert.equal(await verifyPassword(input.password.trim(), hash), false);
  for (const value of ['', 'short', 'x'.repeat(129), undefined, '\ud800abcdefghi']) assert.throws(() => validatePassword(value));
  for (const malformed of ['plaintext', hash.replace('16384', '999999999'), hash + ':extra']) assert.equal(await verifyPassword(input.password, malformed), false);
});
test('OAuth invitations store profile and role without passwords', async () => {
  const invitation = { email: input.email, role: input.role };
  const calls = [];
  const store = new AccountStore({ async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{ id: ID, name: null, email: 'person@example.test', role: 'teacher', created_at: new Date('2026-01-01') }] };
  } });
  assert.deepEqual(await store.create(invitation), { id: ID, name: null, email: 'person@example.test', role: 'teacher', createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(calls[0].values.includes(input.password), false);
  assert.match(calls[0].sql, /'local'/);
  assert.equal(calls[0].values[1], 'teacher');
  assert.doesNotMatch(calls[0].sql, /password/);
  await assert.rejects(new AccountStore({ async query() { return { rows: [] }; } }).create(invitation), DuplicateAccountError);
  await assert.rejects(store.create({ ...invitation, role: 'admin' }));
});
test('authenticated identity reads actual persisted account not approval authority', async () => {
  const calls = [];
  const store = new IdentityStore({ async query(sql, values) { calls.push({ sql, values }); return { rows: [{ name: 'Person', email: 'person@example.test', role: 'student' }] }; } });
  assert.deepEqual(await store.findAccountByOwner(ID), { name: 'Person', email: 'person@example.test', role: 'student' });
  assert.match(calls[0].sql, /FROM lingualoop_accounts WHERE id = \$1/);
});
