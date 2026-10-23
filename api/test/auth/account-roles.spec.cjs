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
test('account invitations accept only profile and student/teacher role, never a password', () => {
  const invitation = { email: input.email, role: 'teacher' };
  assert.deepEqual(validateAccountInput(invitation), invitation);
  for (const value of [null, [], {}, { ...invitation, role: 'admin' }, { ...invitation, extra: true },
    { ...invitation, password: input.password },
    ...['', ' ', 'x'.repeat(121), '\ud800', 'line\nbreak'].map(name => ({ ...invitation, name }))])
    assert.throws(() => validateAccountInput(value));
});

test('retired password authentication and bootstrap never access the database', async () => {
  const store = new AccountStore({ async query() { throw Error('must not query'); },
    async withTransaction() { throw Error('must not transact'); } });
  assert.equal(await store.authenticate(input.email, input.password), null);
  await assert.rejects(store.bootstrapFirstAdmin(input.name, input.email, input.password));
});

test('bootstrap requires explicit exact existing-runtime target and private input, no isolated credentials', () => {
  const env = { LINGUALOOP_DB_HOST: '127.0.0.1', LINGUALOOP_DB_PORT: '6543', LINGUALOOP_BOOTSTRAP_EXISTING_TARGET_CONFIRMED: '127.0.0.1:6543/lingualoop' };
  assert.deepEqual(loadBootstrapConfiguration(env), { host: '127.0.0.1', port: 6543, database: 'lingualoop' });
  for (const overrides of [{ LINGUALOOP_BOOTSTRAP_EXISTING_TARGET_CONFIRMED: undefined }, { LINGUALOOP_BOOTSTRAP_EXISTING_TARGET_CONFIRMED: 'postgres:5432/lingualoop' }, { LINGUALOOP_DB_HOST: 'isolated-host' }, { LINGUALOOP_DB_PORT: '0' }]) assert.throws(() => loadBootstrapConfiguration({ ...env, ...overrides }), /Offline admin bootstrap failed/);
  assert.deepEqual(parseBootstrapInput(input), input);
  for (const value of [{ ...input, password: undefined }, { ...input, name: '' }, { ...input, role: 'admin' }]) assert.throws(() => parseBootstrapInput(value));
});
