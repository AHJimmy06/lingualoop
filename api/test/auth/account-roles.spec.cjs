const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmail } = require('../../dist/auth/account-role.js');
const { AccountStore, validateAccountInput } = require('../../dist/auth/account-store.js');
const { loadBootstrapConfiguration, parseBootstrapInput } = require('../../dist/auth/bootstrap-admin.js');
const ID = '123e4567-e89b-42d3-a456-426614174000';
const input = { name: 'Operator', email: 'person@example.test', password: ' exact password ' };
test('normalized bounded ASCII email retains dots and aliases', () => {
  assert.equal(normalizeEmail(' First.Last+Class@GMAIL.COM '), 'first.last+class@gmail.com');
  for (const value of [undefined, '', 'x', 'a@@b.test', 'a b@c.test', 'é@c.test', 'K@c.test', 'a@-b.test', '.a@b.test', 'a..b@c.test', 'x'.repeat(65) + '@b.test', 'a@' + 'x'.repeat(250) + '.test']) assert.throws(() => normalizeEmail(value));
});
test('account input enforces exact fields, name/password bounds and only teacher/student provisioning', () => {
  assert.equal(validateAccountInput({ ...input, role: 'teacher' }).password, input.password);
  for (const value of [null, [], {}, { ...input, role: 'admin' }, { ...input, role: 'teacher', extra: true },
    ...['', ' ', 'x'.repeat(121), '\ud800', 'line\nbreak'].map(name => ({ ...input, name, role: 'student' })),
    ...['short', 'x'.repeat(129), undefined].map(password => ({ ...input, password, role: 'student' }))]) assert.throws(() => validateAccountInput(value));
});
test('bootstrap locks create-once decision and never promotes or overwrites any existing account', async () => {
  for (const existing of [[], [{ id: ID }]]) {
    const calls = [];
    const store = new AccountStore({ async query() { throw Error('must transact'); }, async withTransaction(callback) {
      return callback({ async query(sql, values) {
        calls.push({ sql, values });
        if (sql.includes('FROM lingualoop_accounts LIMIT 1')) return { rows: existing };
        if (sql.includes('INSERT')) return { rows: [{ id: ID, name: input.name, email: input.email, role: 'admin', created_at: new Date('2026-01-01') }] };
        return { rows: [] };
      } });
    } });
    if (existing.length) await assert.rejects(store.bootstrapFirstAdmin(input.name, input.email, input.password));
    else assert.equal((await store.bootstrapFirstAdmin(input.name, input.email, input.password)).role, 'admin');
    assert.match(calls[0].sql, /pg_advisory_xact_lock/);
    assert.deepEqual(calls[0].values, ['lingualoop:first-admin']);
    assert.equal(calls.some(c => /^\s*UPDATE/.test(c.sql)), false);
    assert.equal(calls.some(c => c.values.includes(input.password)), false);
    if (existing.length) assert.equal(calls.some(c => c.sql.includes('INSERT')), false);
  }
  const duplicate = new AccountStore({ async query() {}, async withTransaction(callback) { return callback({ async query() { return { rows: [] }; } }); } });
  await assert.rejects(duplicate.bootstrapFirstAdmin(input.name, input.email, input.password));
});
test('bootstrap requires explicit exact existing-runtime target and private input, no isolated credentials', () => {
  const env = { LINGUALOOP_DB_HOST: '127.0.0.1', LINGUALOOP_DB_PORT: '6543', LINGUALOOP_BOOTSTRAP_EXISTING_TARGET_CONFIRMED: '127.0.0.1:6543/lingualoop' };
  assert.deepEqual(loadBootstrapConfiguration(env), { host: '127.0.0.1', port: 6543, database: 'lingualoop' });
  for (const overrides of [{ LINGUALOOP_BOOTSTRAP_EXISTING_TARGET_CONFIRMED: undefined }, { LINGUALOOP_BOOTSTRAP_EXISTING_TARGET_CONFIRMED: 'postgres:5432/lingualoop' }, { LINGUALOOP_DB_HOST: 'isolated-host' }, { LINGUALOOP_DB_PORT: '0' }]) assert.throws(() => loadBootstrapConfiguration({ ...env, ...overrides }), /Offline admin bootstrap failed/);
  assert.deepEqual(parseBootstrapInput(input), input);
  for (const value of [{ ...input, password: undefined }, { ...input, name: '' }, { ...input, role: 'admin' }]) assert.throws(() => parseBootstrapInput(value));
});
