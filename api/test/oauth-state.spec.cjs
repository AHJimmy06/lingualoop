const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  InvalidOAuthStateError,
  OAuthStateService,
} = require('../dist/auth/oauth-state.service.js');

class FakeStateStore {
  records = new Map();
  consumeCalls = [];

  async put(hash, record) {
    this.records.set(hash, record);
  }

  async consume(hash) {
    this.consumeCalls.push(hash);
    const record = this.records.get(hash);
    this.records.delete(hash);
    return record ?? null;
  }
}

function service(store = new FakeStateStore(), now = () => 1_000) {
  return { store, service: new OAuthStateService(store, now) };
}

function hashState(state) {
  return createHash('sha256').update(state).digest('hex');
}

test('creates a 32-byte url-safe state and stores only its hash with the default TTL', async () => {
  const { store, service: states } = service();
  const state = await states.createState();

  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.records.size, 1);
  assert.deepEqual(store.records.get(hashState(state)), {
    expiresAt: 301_000,
    provider: undefined,
  });
  assert.equal(store.records.has(state), false);
});

test('validates state before touching the store and rejects unknown or malformed states', async () => {
  const { store, service: states } = service();
  await assert.rejects(states.consumeState('not-a-state'), InvalidOAuthStateError);
  await assert.rejects(states.consumeState('A'.repeat(42)), InvalidOAuthStateError);
  await assert.rejects(states.consumeState('A'.repeat(44)), InvalidOAuthStateError);
  await assert.rejects(states.consumeState(`${'A'.repeat(42)}!`), InvalidOAuthStateError);
  assert.equal(store.consumeCalls.length, 0);
  await assert.rejects(states.consumeState('A'.repeat(43)), InvalidOAuthStateError);
  assert.equal(store.consumeCalls.length, 1);
});

test('consumes a state at most once under concurrent callbacks', async () => {
  const { service: states } = service();
  const state = await states.createState();

  const results = await Promise.allSettled([
    states.consumeState(state),
    states.consumeState(state),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason instanceof InvalidOAuthStateError).length, 1);
});

test('rejects expired state using the injected clock', async () => {
  let now = 1_000;
  const { service: states } = service(new FakeStateStore(), () => now);
  const state = await states.createState({ ttlMs: 10 });
  now = 1_010;

  await assert.rejects(states.consumeState(state), InvalidOAuthStateError);
});

test('binds an optional provider marker and consumes/rejects on provider mismatch', async () => {
  const { store, service: states } = service();
  const state = await states.createState({ provider: 'provider-a' });

  await assert.rejects(states.consumeState(state, 'provider-b'), InvalidOAuthStateError);
  assert.equal(store.records.size, 0);
  await assert.rejects(states.consumeState(state, 'provider-a'), InvalidOAuthStateError);
});

test('allows a matching provider and rejects invalid TTL or provider input before storage', async () => {
  const { store, service: states } = service();
  const state = await states.createState({ provider: 'provider-a', ttlMs: 2_000 });
  assert.deepEqual(store.records.get(hashState(state)), {
    expiresAt: 3_000,
    provider: 'provider-a',
  });
  await states.consumeState(state, 'provider-a');

  for (const options of [
    { ttlMs: 0 },
    { ttlMs: Number.NaN },
    { ttlMs: 5 * 60 * 1_000 + 1 },
    { provider: '' },
    { provider: ' bad' },
  ]) {
    const before = store.records.size;
    await assert.rejects(states.createState(options), RangeError);
    assert.equal(store.records.size, before);
  }
});

test('rejects expiry values that are not safe integers before storage', async () => {
  const { store, service: states } = service(new FakeStateStore(), () => Number.MAX_SAFE_INTEGER);

  await assert.rejects(states.createState({ ttlMs: 1 }), RangeError);
  assert.equal(store.records.size, 0);
});
