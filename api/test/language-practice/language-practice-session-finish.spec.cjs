const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LanguagePracticeSessionStore,
  LanguagePracticeSessionStoreError,
  LanguagePracticeSessionFinishError,
} = require('../../dist/language-practice/language-practice-session-store.js');

const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_OWNER = '123e4567-e89b-42d3-a456-426614174002';
const SESSION = '123e4567-e89b-42d3-a456-426614174001';

function storeFor(responses) {
  const calls = [];
  return {
    calls,
    store: new LanguagePracticeSessionStore({
      async withTransaction(callback) {
        return callback({ query: (sql, parameters) => {
          if (sql.includes('FOR UPDATE')) return { rows: [{ id: SESSION }] };
          if (sql.includes('DELETE FROM')) return { rows: [] };
          return this.query(sql, parameters);
        } });
      },
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    }),
  };
}

const closedRow = { id: SESSION, status: 'COMPLETED' };

test('completed session detail normalizes remaining time to zero while active time is preserved', async () => {
  const baseRow = {
    id: SESSION, difficulty: null, level: 'B1', topic: 'travel', durationMinutes: 10,
    startedAt: new Date('2026-09-24T12:00:00.000Z'), expiresAt: new Date('2026-09-24T12:10:00.000Z'),
    remainingMs: 42_000,
  };
  const completed = storeFor([{ rows: [{ ...baseRow, status: 'COMPLETED' }] }]);
  assert.equal((await completed.store.getSession(OWNER, SESSION)).remainingMs, 0);
  const active = storeFor([{ rows: [{ ...baseRow, status: 'ACTIVE' }] }]);
  assert.equal((await active.store.getSession(OWNER, SESSION)).remainingMs, 42_000);
});

test('finish atomically closes only an owned active session with no lease', async () => {
  const fake = storeFor([{ rows: [closedRow] }]);
  assert.deepEqual(await fake.store.finishSession(OWNER, SESSION), closedRow);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].sql, /UPDATE lingualoop_language_practice_sessions/i);
  assert.match(fake.calls[0].sql, /owner_id\s*=\s*\$1/i);
  assert.match(fake.calls[0].sql, /id\s*=\s*\$2/i);
  assert.match(fake.calls[0].sql, /status\s*=\s*'ACTIVE'/i);
  assert.match(fake.calls[0].sql, /active_turn_lease_token\s+IS\s+NULL/i);
  assert.match(fake.calls[0].sql, /expires_at\s*>\s*clock_timestamp\(\)/i);
  assert.deepEqual(fake.calls[0].parameters, [OWNER, SESSION]);
  assert.doesNotMatch(fake.calls[0].sql, /lingualoop_language_practice_turns/i);
});

test('finish returns stable existing completed or expired status without modifying turns', async () => {
  const fake = storeFor([
    { rows: [] }, { rows: [{ id: SESSION, status: 'COMPLETED', activeTurnLeaseToken: null, elapsed: false }] },
    { rows: [] }, { rows: [{ id: SESSION, status: 'EXPIRED', activeTurnLeaseToken: null, elapsed: true }] },
    { rows: [] }, { rows: [{ id: SESSION, status: 'ACTIVE', activeTurnLeaseToken: null, elapsed: true }] },
  ]);
  assert.deepEqual(await fake.store.finishSession(OWNER, SESSION), { id: SESSION, status: 'COMPLETED' });
  assert.deepEqual(await fake.store.finishSession(OWNER, SESSION), { id: SESSION, status: 'EXPIRED' });
  assert.deepEqual(await fake.store.finishSession(OWNER, SESSION), { id: SESSION, status: 'EXPIRED' });
  assert.equal(fake.calls.length, 6);
  for (const call of fake.calls) assert.doesNotMatch(call.sql, /lingualoop_language_practice_turns/i);
});

test('finish rejects active lease and hides missing or unowned sessions', async () => {
  const leased = storeFor([
    { rows: [] }, { rows: [{ id: SESSION, status: 'ACTIVE', activeTurnLeaseToken: '123e4567-e89b-42d3-a456-426614174003', elapsed: false }] },
  ]);
  await assert.rejects(leased.store.finishSession(OWNER, SESSION), (error) =>
    error instanceof LanguagePracticeSessionFinishError && error.reason === 'turn_in_progress');
  const missing = storeFor([{ rows: [] }, { rows: [] }]);
  assert.equal(await missing.store.finishSession(OTHER_OWNER, SESSION), null);
  assert.deepEqual(missing.calls.map(({ parameters }) => parameters), [[OTHER_OWNER, SESSION], [OTHER_OWNER, SESSION]]);
});

test('finish rejects malformed UUIDs before querying and hides database details', async () => {
  const fake = storeFor([]);
  await assert.rejects(fake.store.finishSession(OWNER, 'bad'), LanguagePracticeSessionStoreError);
  assert.equal(fake.calls.length, 0);
  const failed = storeFor([new Error('private database diagnostics')]);
  await assert.rejects(failed.store.finishSession(OWNER, SESSION), (error) =>
    error instanceof LanguagePracticeSessionStoreError && !error.message.includes('private database'));
});

test('concurrent finish/turn reservation safety is encoded as a conditional session-row update', async () => {
  const fake = storeFor([{ rows: [closedRow] }]);
  await fake.store.finishSession(OWNER, SESSION);
  const sql = fake.calls[0].sql;
  assert.match(sql, /UPDATE\s+lingualoop_language_practice_sessions[\s\S]*WHERE/i);
  assert.match(sql, /active_turn_lease_token\s+IS\s+NULL/i);
  assert.match(sql, /status\s*=\s*'ACTIVE'/i);
  assert.match(sql, /RETURNING\s+id,\s*status/i);
});


test('empty owned session is discarded under the turn lock, never completed or reported', async () => {
  const calls = [];
  const executor = { async withTransaction(callback) { return callback(this); }, async query(sql, values) {
    calls.push({sql, values});
    return {rows: [{id: SESSION}]};
  }};
  assert.deepEqual(await new LanguagePracticeSessionStore(executor).finishSession(OWNER, SESSION), {id: SESSION, status: 'DISCARDED'});
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.match(calls[1].sql, /DELETE FROM/);
  assert.match(calls[1].sql, /active_turn_lease_token IS NULL/);
  assert.match(calls[1].sql, /NOT EXISTS[\s\S]*t.status = 'COMPLETED'/);
  for (const call of calls) assert.deepEqual(call.values, [OWNER, SESSION]);
});

test('missing or foreign session cannot be discarded', async () => {
  let calls = 0;
  const executor = {async withTransaction(callback) { return callback(this); }, async query() { calls++; return {rows: []}; }};
  assert.equal(await new LanguagePracticeSessionStore(executor).finishSession(OTHER_OWNER, SESSION), null);
  assert.equal(calls, 1);
});
