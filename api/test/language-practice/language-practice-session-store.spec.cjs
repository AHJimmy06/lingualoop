const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LanguagePracticeSessionStore,
  LanguagePracticeSessionStoreError,
} = require('../../dist/language-practice/language-practice-session-store.js');

const OWNER_ID = '123e4567-e89b-42d3-a456-426614174000';
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174001';
const createdRow = {
  id: SESSION_ID,
  status: 'ACTIVE',
  level: 'B1',
  topic: 'travel',
  durationMinutes: 10,
  startedAt: new Date('2026-09-24T12:00:00.000Z'),
  expiresAt: new Date('2026-09-24T12:10:00.000Z'),
};

function fakeExecutor(result, error) {
  const calls = [];
  return {
    calls,
    store: new LanguagePracticeSessionStore({
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        if (error) throw error;
        return result;
      },
    }),
  };
}

test('creates an original-catalog session with owner binding and database-derived timestamps', async () => {
  const fake = fakeExecutor({ rows: [createdRow] });
  const session = await fake.store.createSession(OWNER_ID, {
    level: 'B1', topic: 'travel', durationMinutes: 10,
  });
  assert.deepEqual(session, {
    id: SESSION_ID,
    status: 'ACTIVE',
    level: 'B1',
    topic: 'travel',
    durationMinutes: 10,
    startedAt: '2026-09-24T12:00:00.000Z',
    expiresAt: '2026-09-24T12:10:00.000Z',
  });
  assert.match(fake.calls[0].sql, /INSERT INTO lingualoop_language_practice_sessions/i);
  assert.match(fake.calls[0].sql, /VALUES \(\$1, \$2, \$3, \$4, NOW\(\), NOW\(\) \+ \$4 \* INTERVAL '1 minute'\)/i);
  assert.match(fake.calls[0].sql, /RETURNING id, status, level, topic,\s+duration_minutes AS "durationMinutes",\s+started_at AS "startedAt", expires_at AS "expiresAt"/i);
  assert.deepEqual(fake.calls[0].parameters, [OWNER_ID, 'B1', 'travel', 10]);
  assert.ok(!fake.calls[0].sql.includes(OWNER_ID));
});

test('retrieves a session only by the bound owner and session UUIDs', async () => {
  const fake = fakeExecutor({ rows: [createdRow] });
  const session = await fake.store.getSession(OWNER_ID, SESSION_ID);
  assert.equal(session.id, SESSION_ID);
  assert.match(fake.calls[0].sql, /WHERE owner_id = \$1 AND id = \$2/i);
  assert.deepEqual(fake.calls[0].parameters, [OWNER_ID, SESSION_ID]);
  assert.equal(await fakeExecutor({ rows: [] }).store.getSession(OWNER_ID, SESSION_ID), null);
});

test('rejects non-original setup values and malformed UUIDs before querying', async () => {
  const fake = fakeExecutor({ rows: [createdRow] });
  const invalidSetups = [
    { level: 'A0', topic: 'travel', durationMinutes: 5 },
    { level: 'C2', topic: 'work', durationMinutes: 20 },
    { level: 'B1', topic: 'music', durationMinutes: 10 },
    { level: 'B1', topic: 'everyday-conversation', durationMinutes: '10' },
    null,
  ];
  for (const setup of invalidSetups) await assert.rejects(fake.store.createSession(OWNER_ID, setup), LanguagePracticeSessionStoreError);
  await assert.rejects(fake.store.createSession('owner', { level: 'A1', topic: 'studies', durationMinutes: 5 }), LanguagePracticeSessionStoreError);
  await assert.rejects(fake.store.getSession(OWNER_ID, 'session'), LanguagePracticeSessionStoreError);
  assert.equal(fake.calls.length, 0);
});

test('malformed query results and database diagnostics fail with a generic store error', async () => {
  for (const rows of [[], [null], [{ ...createdRow, id: 'bad' }], [{ ...createdRow, status: 'UNKNOWN' }], [createdRow, createdRow]]) {
    await assert.rejects(fakeExecutor({ rows }).store.createSession(OWNER_ID, {
      level: 'B1', topic: 'travel', durationMinutes: 10,
    }), LanguagePracticeSessionStoreError);
  }
  const secret = 'private database diagnostic';
  await assert.rejects(fakeExecutor(null, new Error(secret)).store.createSession(OWNER_ID, {
    level: 'B1', topic: 'travel', durationMinutes: 10,
  }), (error) => error instanceof LanguagePracticeSessionStoreError && !error.message.includes(secret));
});

test('migration encodes the original catalog and LinguaLoop owner foreign key', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/005_language_practice_sessions.sql'), 'utf8');
  assert.match(migration, /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
  assert.match(migration, /owner_id UUID NOT NULL REFERENCES lingualoop_accounts\(id\) ON DELETE CASCADE/i);
  for (const level of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) assert.match(migration, new RegExp(`'${level}'`));
  for (const topic of ['travel', 'work', 'studies', 'everyday-conversation']) assert.match(migration, new RegExp(`'${topic}'`));
  for (const duration of [5, 10, 15]) assert.match(migration, new RegExp(`\\b${duration}\\b`));
  assert.match(migration, /DEFAULT NOW\(\)/i);
  assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL/i);
});
