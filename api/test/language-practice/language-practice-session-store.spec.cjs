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
  difficulty: 'medium',
  startedAt: new Date('2026-09-24T12:00:00.000Z'),
  expiresAt: new Date('2026-09-24T12:10:00.000Z'),
  remainingMs: 600000,
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
    difficulty: 'medium',
    startedAt: '2026-09-24T12:00:00.000Z',
    expiresAt: '2026-09-24T12:10:00.000Z',
    remainingMs: 600000,
    turnInProgress: false,
  });
  assert.match(fake.calls[0].sql, /INSERT INTO lingualoop_language_practice_sessions/i);
  assert.match(fake.calls[0].sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, NOW\(\), NOW\(\) \+ \$4::integer \* INTERVAL '1 minute'\)/i);
  assert.match(fake.calls[0].sql, /RETURNING id, status, level, topic, difficulty,\s+duration_minutes AS "durationMinutes",\s+started_at AS "startedAt", expires_at AS "expiresAt",\s+duration_minutes \* 60000 AS "remainingMs"/i);
  assert.deepEqual(fake.calls[0].parameters, [OWNER_ID, 'B1', 'travel', 10, 'medium']);
  assert.ok(!fake.calls[0].sql.includes(OWNER_ID));
});

test('retrieves a session only by the bound owner and session UUIDs', async () => {
  const fake = fakeExecutor({ rows: [createdRow] });
  const session = await fake.store.getSession(OWNER_ID, SESSION_ID);
  assert.equal(session.id, SESSION_ID);
  assert.match(fake.calls[0].sql, /WHERE owner_id = \$1 AND id = \$2/i);
  assert.match(fake.calls[0].sql, /GREATEST\(0, FLOOR\(EXTRACT\(EPOCH FROM \(expires_at - NOW\(\)\)\) \* 1000\)::INTEGER\) AS "remainingMs"/i);
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

test('internal snapshot validates theme and retains NULL default/historical semantics', async () => {
  for (const conversation_theme_snapshot of [null, undefined, ' Coffee\norders 😀 ']) {
    const fake = fakeExecutor({ rows: [{ level: 'B1', topic: 'travel', difficulty: null, parameters_snapshot: [], conversation_theme_snapshot }] });
    assert.deepEqual(await fake.store.getOwnedSnapshot(OWNER_ID, SESSION_ID), {
      level: 'B1', topic: 'travel', difficulty: null, parameters: [], conversationTheme: conversation_theme_snapshot ?? null,
    });
    assert.match(fake.calls[0].sql, /conversation_theme_snapshot/);
    assert.match(fake.calls[0].sql, /owner_id = \$1::uuid AND id = \$2::uuid/);
    assert.equal(fake.calls[0].sql.includes('lingualoop_practices'), false);
  }
  for (const conversation_theme_snapshot of ['', 'x'.repeat(121), 'bad\u0000theme', '\ud800', 12]) {
    const fake = fakeExecutor({ rows: [{ level: 'B1', topic: 'travel', difficulty: null, parameters_snapshot: [], conversation_theme_snapshot }] });
    await assert.rejects(fake.store.getOwnedSnapshot(OWNER_ID, SESSION_ID), LanguagePracticeSessionStoreError);
  }
  assert.equal(await fakeExecutor({ rows: [] }).store.getOwnedSnapshot(OWNER_ID, SESSION_ID), null);
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


test('session image lookup uses persisted practice link and owner/session parameters', async () => {
  const bytes = Buffer.from([255, 216, 255, 217]);
  const fake = fakeExecutor({ rows: [{ bytes, mime: 'image/jpeg' }] });
  assert.deepEqual(await fake.store.getSessionImage(OWNER_ID, SESSION_ID), { bytes, mime: 'image/jpeg' });
  assert.deepEqual(fake.calls[0].parameters, [OWNER_ID, SESSION_ID]);
  assert.match(fake.calls[0].sql, /i.practice_id = s.practice_id/);
  assert.match(fake.calls[0].sql, /s.owner_id = \$1::uuid AND s.id = \$2::uuid/);
  assert.equal(await fakeExecutor({ rows: [{ bytes: null, mime: null }] }).store.getSessionImage(OWNER_ID, SESSION_ID), null);
  for (const rows of [[], [{ bytes: Buffer.alloc(0), mime: 'image/jpeg' }], [{ bytes, mime: 'text/html' }]]) {
    await assert.rejects(fakeExecutor({ rows }).store.getSessionImage(OWNER_ID, SESSION_ID), LanguagePracticeSessionStoreError);
  }
});
