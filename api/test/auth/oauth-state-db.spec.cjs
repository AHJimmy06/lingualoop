const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { OAuthStateDbStore, OAuthStateStoreError } = require('../../dist/auth/oauth-state-db.js');
const { InvalidOAuthStateError, OAuthStateService } = require('../../dist/auth/oauth-state.service.js');

class FakeExecutor {
  records = new Map();
  calls = [];
  consumeRows;

  async query(sql, parameters) {
    this.calls.push({ sql, parameters });
    if (sql.includes('INSERT INTO')) {
      const [hash, expiresAt, provider] = parameters;
      if (this.records.has(hash)) throw new Error('duplicate key');
      this.records.set(hash, { expires_at_ms: String(expiresAt), provider });
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM')) {
      const [hash] = parameters;
      const row = this.consumeRows !== undefined ? this.consumeRows : this.records.get(hash);
      this.consumeRows = undefined;
      this.records.delete(hash);
      return { rows: row === undefined ? [] : [row] };
    }
    throw new Error('unexpected query');
  }
}

function hashState(state) {
  return createHash('sha256').update(state).digest('hex');
}

test('OAuthStateService consumes a PostgreSQL-backed hash at most once', async () => {
  const executor = new FakeExecutor();
  const store = new OAuthStateDbStore(executor);
  const states = new OAuthStateService(store, () => 1_000);
  const state = await states.createState({ provider: 'google' });

  assert.equal(executor.records.has(hashState(state)), true);
  assert.equal(executor.records.has(state), false);
  const results = await Promise.allSettled([states.consumeState(state, 'google'), states.consumeState(state, 'google')]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status, reason }) => status === 'rejected' && reason instanceof InvalidOAuthStateError).length, 1);
  const consume = executor.calls.find(({ sql }) => sql.includes('DELETE FROM'));
  assert.match(consume.sql, /DELETE FROM lingualoop_oauth_states[\s\S]*RETURNING expires_at_ms, provider/);
  assert.deepEqual(consume.parameters, [hashState(state)]);
});

test('requires a Google provider marker and validates writes before querying', async () => {
  const executor = new FakeExecutor();
  const store = new OAuthStateDbStore(executor);
  for (const [hash, record] of [
    ['A'.repeat(64), { expiresAt: 1, provider: 'google' }],
    ['a'.repeat(64), { expiresAt: 0, provider: 'google' }],
    ['a'.repeat(64), { expiresAt: Number.MAX_SAFE_INTEGER + 1, provider: 'google' }],
    ['a'.repeat(64), { expiresAt: 1, provider: undefined }],
    ['a'.repeat(64), { expiresAt: 1, provider: 'nousai' }],
  ]) {
    await assert.rejects(store.put(hash, record), OAuthStateStoreError);
  }
  await assert.rejects(store.consume('a'.repeat(63)), OAuthStateStoreError);
  assert.equal(executor.calls.length, 0);
});

test('rejects malformed or unsafe rows returned by atomic consume', async () => {
  const cases = [
    null,
    { expires_at_ms: 'not-a-number', provider: 'google' },
    { expires_at_ms: String(Number.MAX_SAFE_INTEGER + 1), provider: 'google' },
    { expires_at_ms: '1', provider: 'nousai' },
    { expires_at_ms: '1' },
  ];
  for (const row of cases) {
    const executor = new FakeExecutor();
    executor.consumeRows = row;
    const store = new OAuthStateDbStore(executor);
    await assert.rejects(store.consume('a'.repeat(64)), OAuthStateStoreError);
  }

  const executor = new FakeExecutor();
  executor.consumeRows = { expires_at_ms: '42', provider: 'google' };
  assert.deepEqual(await new OAuthStateDbStore(executor).consume('a'.repeat(64)), {
    expiresAt: 42,
    provider: 'google',
  });
});

test('does not overwrite hash collisions and hides executor errors', async () => {
  const executor = new FakeExecutor();
  const store = new OAuthStateDbStore(executor);
  const hash = 'b'.repeat(64);
  await store.put(hash, { expiresAt: 10, provider: 'google' });
  await assert.rejects(store.put(hash, { expiresAt: 20, provider: 'google' }), OAuthStateStoreError);
  assert.deepEqual(executor.records.get(hash), { expires_at_ms: '10', provider: 'google' });

  const broken = new OAuthStateDbStore({ async query() { throw new Error('secret SQL/state'); } });
  await assert.rejects(broken.consume('c'.repeat(64)), (error) => {
    assert.equal(error.message, 'OAuth state store operation failed.');
    assert.equal(error.message.includes('secret'), false);
    return error instanceof OAuthStateStoreError;
  });
});
