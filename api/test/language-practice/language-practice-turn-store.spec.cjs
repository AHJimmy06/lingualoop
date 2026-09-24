const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { runLinguaLoopMigrations } = require('../../dist/db/migrate.js');
const {
  LanguagePracticeTurnStore,
  LanguagePracticeTurnStoreError,
  LanguagePracticeTurnAdmissionError,
} = require('../../dist/language-practice/language-practice-turn-store.js');

const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const SESSION = '223e4567-e89b-42d3-a456-426614174000';
const CLIENT_TURN = '323e4567-e89b-42d3-a456-426614174000';
const TURN = '423e4567-e89b-42d3-a456-426614174000';
const LEASE = '523e4567-e89b-42d3-a456-426614174000';
const LEASE_END = '2026-09-24T12:00:30.000Z';
const FOREIGN_OWNER = '123e4567-e89b-42d3-a456-426614174001';
const FOREIGN_SESSION = '223e4567-e89b-42d3-a456-426614174001';
const DISPOSABLE_PASSWORD = 'disposable-postgres-test-password';
const IMAGE = 'postgres:16-alpine';
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Disposable PostgreSQL Docker command failed: ${args[0]}`);
  return result.stdout.trim();
}

async function waitForPostgres(config) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new Client(config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Disposable PostgreSQL did not become ready: ${lastError?.message ?? 'timeout'}`);
}

function fakeQuery(result, error) {
  const calls = [];
  return {
    calls,
    store: new LanguagePracticeTurnStore({
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        if (error) throw error;
        return result;
      },
    }),
  };
}

function row(overrides = {}) {
  return {
    outcome: 'admitted', turn_id: TURN, client_turn_id: CLIENT_TURN,
    turn_sequence: 1, turn_status: 'PROCESSING', lease_token: LEASE,
    lease_expires_at: LEASE_END, transcript: null, assistant_response: null,
    failure_code: null, spanish_correction_evidence: null, completed_at: null, ...overrides,
  };
}

test('reservation makes one bound atomic function call and returns its lease', async () => {
  const fake = fakeQuery({ rows: [row()] });
  const reservation = await fake.store.reserveTurn(OWNER, SESSION, CLIENT_TURN);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].sql, /lingualoop_reserve_language_practice_turn/);
  assert.deepEqual(fake.calls[0].parameters, [OWNER, SESSION, CLIENT_TURN]);
  assert.deepEqual(reservation, {
    replay: false,
    turn: {
      id: TURN, clientTurnId: CLIENT_TURN, sequence: 1, status: 'PROCESSING',
      leaseToken: LEASE, leaseExpiresAt: LEASE_END, transcript: null,
      assistantResponse: null, failureCode: null, spanishCorrectionEvidence: null, completedAt: null,
    },
  });
});

test('owned idempotent replay returns prior completed text without another admission', async () => {
  const fake = fakeQuery({ rows: [row({
    outcome: 'replay', turn_status: 'COMPLETED', lease_token: null, lease_expires_at: null,
    transcript: 'hello', assistant_response: 'Welcome.',
    spanish_correction_evidence: '{"correctedPhrase":"hello","feedback":"Good."}',
    completed_at: new Date(LEASE_END),
  })] });
  const replay = await fake.store.reserveTurn(OWNER, SESSION, CLIENT_TURN);
  assert.equal(replay.replay, true);
  assert.equal(replay.turn.transcript, 'hello');
  assert.equal(replay.turn.assistantResponse, 'Welcome.');
  assert.equal(replay.turn.spanishCorrectionEvidence, '{"correctedPhrase":"hello","feedback":"Good."}');
  assert.equal(fake.calls.length, 1);
});

test('foreign or absent session and session/lease admission failures are distinct domain outcomes', async () => {
  for (const reason of ['not_found', 'session_expired', 'turn_in_progress']) {
    const fake = fakeQuery({ rows: [row({ outcome: reason, turn_id: null, client_turn_id: null,
      turn_sequence: null, turn_status: null, lease_token: null, lease_expires_at: null,
      transcript: null, assistant_response: null, failure_code: null, completed_at: null })] });
    await assert.rejects(fake.store.reserveTurn(OWNER, SESSION, CLIENT_TURN), (error) => {
      assert.ok(error instanceof LanguagePracticeTurnAdmissionError);
      assert.equal(error.reason, reason);
      return true;
    });
  }
});

test('completion and failure bind owner, session, turn, and exact lease token', async () => {
  const complete = fakeQuery({ rows: [{ completed: true }] });
  assert.equal(await complete.store.completeTurn(
    OWNER, SESSION, TURN, LEASE, 'spoken words', 'response', '{"correctedPhrase":"spoken words","feedback":"Good."}',
  ), true);
  assert.match(complete.calls[0].sql, /lingualoop_complete_language_practice_turn/);
  assert.deepEqual(complete.calls[0].parameters, [
    OWNER, SESSION, TURN, LEASE, 'spoken words', 'response',
    '{"correctedPhrase":"spoken words","feedback":"Good."}',
  ]);

  const fail = fakeQuery({ rows: [{ failed: false }] });
  assert.equal(await fail.store.failTurn(OWNER, SESSION, TURN, LEASE), false);
  assert.match(fail.calls[0].sql, /lingualoop_fail_language_practice_turn/);
  assert.deepEqual(fail.calls[0].parameters, [OWNER, SESSION, TURN, LEASE]);
});

test('completion evidence is bounded to the original 2000-character limit', async () => {
  const fake = fakeQuery({ rows: [{ completed: true }] });
  const evidence = 'x'.repeat(2_005);
  assert.equal(await fake.store.completeTurn(OWNER, SESSION, TURN, LEASE, 'words', 'reply', evidence), true);
  assert.equal(fake.calls[0].parameters[6].length, 2_000);
  assert.equal(fake.calls[0].parameters[6], evidence.slice(0, 2_000));
});

test('audio has no store parameter and invalid identifiers or fabricated empty output are rejected', async () => {
  const fake = fakeQuery({ rows: [{ completed: true }] });
  await assert.rejects(fake.store.reserveTurn('foreign', SESSION, CLIENT_TURN), LanguagePracticeTurnStoreError);
  await assert.rejects(fake.store.completeTurn(OWNER, SESSION, TURN, LEASE, '', 'made up'), LanguagePracticeTurnStoreError);
  await assert.rejects(fake.store.failTurn(OWNER, SESSION, TURN, 'not-a-lease'), LanguagePracticeTurnStoreError);
  assert.equal(fake.calls.length, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../../src/language-practice/language-practice-turn-store.ts'), 'utf8'), /audioBase64|audioBuffer|audioBytes/i);
});

test('SQL failure and malformed rows are sanitized', async () => {
  const failed = fakeQuery(null, new Error('private SQL parameters'));
  await assert.rejects(failed.store.reserveTurn(OWNER, SESSION, CLIENT_TURN), (error) => {
    assert.equal(error.message, 'Language practice turn store operation failed.');
    assert.equal(error.message.includes('private SQL'), false);
    return true;
  });
  for (const bad of [[], [row({ turn_id: 'not-a-uuid' })], [row({ turn_sequence: 0 })], [row(), row()]]) {
    const malformed = fakeQuery({ rows: bad });
    await assert.rejects(malformed.store.reserveTurn(OWNER, SESSION, CLIENT_TURN), LanguagePracticeTurnStoreError);
  }
});

test('replay function casts varchar turn fields to its declared text result types', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/006_language_practice_turns.sql'), 'utf8');
  const replay = migration.split("RETURN QUERY SELECT 'replay'::TEXT")[1].split('RETURN;')[0];
  assert.match(replay, /existing_turn\.status::TEXT/);
  assert.match(replay, /existing_turn\.failure_code::TEXT/);
  assert.doesNotMatch(replay, /existing_turn\.failure_code\s*[,;]/);
});

test('completed history query binds both owner and session and rejects invalid UUIDs generically', async () => {
  const fake = fakeQuery({ rows: [] });
  assert.deepEqual(await fake.store.getCompletedHistory(OWNER, SESSION), []);
  assert.deepEqual(fake.calls[0].parameters, [OWNER, SESSION]);
  assert.match(fake.calls[0].sql, /INNER JOIN lingualoop_language_practice_sessions AS s ON s\.id = t\.session_id/i);
  assert.match(fake.calls[0].sql, /s\.owner_id = \$1::uuid AND s\.id = \$2::uuid AND t\.status = 'COMPLETED'/i);
  assert.match(fake.calls[0].sql, /ORDER BY t\.sequence DESC\s+LIMIT 10/i);
  assert.match(fake.calls[0].sql, /ORDER BY sequence ASC/i);
  assert.match(fake.calls[0].sql, /LEFT\(t\.transcript, 2000\)/i);
  assert.match(fake.calls[0].sql, /LEFT\(t\.assistant_response, 2000\)/i);
  await assert.rejects(fake.store.getCompletedHistory('bad-owner', SESSION), LanguagePracticeTurnStoreError);
  assert.equal(fake.calls.length, 1);
});

test('completed turn listing binds owner and session and rejects malformed identifiers generically', async () => {
  const completedAt = '2026-09-24T12:00:30.000Z';
  const fake = fakeQuery({ rows: [{ sequence: 1, transcript: 'hello', assistant_response: 'Welcome.', completed_at: completedAt }] });
  assert.deepEqual(await fake.store.listCompletedTurns(OWNER, SESSION), [
    { sequence: 1, transcript: 'hello', assistantResponse: 'Welcome.', completedAt },
  ]);
  assert.deepEqual(fake.calls[0].parameters, [OWNER, SESSION]);
  assert.match(fake.calls[0].sql, /INNER JOIN lingualoop_language_practice_sessions AS s ON s\.id = t\.session_id/i);
  assert.match(fake.calls[0].sql, /s\.owner_id = \$1::uuid AND s\.id = \$2::uuid AND t\.status = 'COMPLETED'/i);
  assert.match(fake.calls[0].sql, /ORDER BY t\.sequence DESC\s+LIMIT 256/i);
  assert.match(fake.calls[0].sql, /ORDER BY sequence ASC/i);
  assert.match(fake.calls[0].sql, /LEFT\(t\.transcript, 2000\)/i);
  assert.match(fake.calls[0].sql, /LEFT\(t\.assistant_response, 2000\)/i);
  await assert.rejects(fake.store.listCompletedTurns('bad-owner', SESSION), LanguagePracticeTurnStoreError);
  const malformedTimestamp = fakeQuery({ rows: [{ sequence: 1, transcript: 'hello', assistant_response: 'Welcome.', completed_at: 'invalid' }] });
  await assert.rejects(malformedTimestamp.store.listCompletedTurns(OWNER, SESSION), LanguagePracticeTurnStoreError);
  const oversized = fakeQuery({ rows: Array.from({ length: 257 }, () => ({})) });
  await assert.rejects(oversized.store.listCompletedTurns(OWNER, SESSION), LanguagePracticeTurnStoreError);
  assert.equal(fake.calls.length, 1);
});

test('disposable PostgreSQL history is owner-filtered, completed-only, chronological, and bounded', {
  timeout: 180_000,
}, async () => {
  let container;
  let client;
  try {
    container = docker([
      'run', '--rm', '--detach', '--publish', '127.0.0.1::5432',
      '--env', `POSTGRES_PASSWORD=${DISPOSABLE_PASSWORD}`,
      '--env', 'POSTGRES_DB=lingualoop_test', IMAGE,
    ]);
    const publishedPort = docker(['port', container, '5432/tcp']).split(':').at(-1);
    assert.match(publishedPort, /^\d+$/);
    const config = {
      host: '127.0.0.1', port: Number(publishedPort), database: 'lingualoop_test',
      user: 'postgres', password: DISPOSABLE_PASSWORD, connectionTimeoutMillis: 1_000,
    };
    client = await waitForPostgres(config);
    await runLinguaLoopMigrations(client, MIGRATIONS_DIR);
    await client.end();
    client = new Client(config);
    await client.connect();

    await client.query(
      "INSERT INTO lingualoop_accounts (id, issuer, subject) VALUES ($1, 'google', 'history-owner'), ($2, 'google', 'history-foreign-owner')",
      [OWNER, FOREIGN_OWNER],
    );
    await client.query(
      "INSERT INTO lingualoop_language_practice_sessions " +
        "(id, owner_id, level, topic, duration_minutes, expires_at) VALUES " +
        "($1, $2, 'A1', 'travel', 5, clock_timestamp() + INTERVAL '1 hour'), " +
        "($3, $4, 'A1', 'travel', 5, clock_timestamp() + INTERVAL '1 hour')",
      [SESSION, OWNER, FOREIGN_SESSION, FOREIGN_OWNER],
    );

    for (let sequence = 1; sequence <= 260; sequence += 1) {
      await client.query(
        'INSERT INTO lingualoop_language_practice_turns ' +
          '(id, session_id, client_turn_id, sequence, status, transcript, assistant_response, completed_at) ' +
          "VALUES ($1, $2, $3, $4, 'COMPLETED', $5, $6, now())",
        [
          `423e4567-e89b-42d3-a456-${String(sequence).padStart(12, '0')}`,
          SESSION,
          `323e4567-e89b-42d3-a456-${String(sequence).padStart(12, '0')}`,
          sequence,
          sequence === 260 ? 'x'.repeat(2_005) : `learner-${sequence}`,
          sequence === 260 ? 'y'.repeat(2_005) : `assistant-${sequence}`,
        ],
      );
    }
    await client.query(
      'INSERT INTO lingualoop_language_practice_turns ' +
        '(id, session_id, client_turn_id, sequence, status, failure_code) ' +
        "VALUES ('423e4567-e89b-42d3-a456-000000000261', $1, '323e4567-e89b-42d3-a456-000000000261', 261, 'FAILED', 'test'), " +
        "('423e4567-e89b-42d3-a456-000000000262', $1, '323e4567-e89b-42d3-a456-000000000262', 262, 'PROCESSING', NULL)",
      [SESSION],
    );
    await client.query(
      'INSERT INTO lingualoop_language_practice_turns ' +
        '(id, session_id, client_turn_id, sequence, status, transcript, assistant_response, completed_at) ' +
        "VALUES ('423e4567-e89b-42d3-a456-000000000263', $1, '323e4567-e89b-42d3-a456-000000000263', 1, 'COMPLETED', 'foreign learner', 'foreign assistant', now())",
      [FOREIGN_SESSION],
    );

    const store = new LanguagePracticeTurnStore({ query: (sql, parameters) => client.query(sql, parameters) });
    const listed = await store.listCompletedTurns(OWNER, SESSION);
    assert.equal(listed.length, 256);
    assert.equal(listed[0].sequence, 5);
    assert.equal(listed.at(-1).sequence, 260);
    assert.equal(listed.at(-1).transcript.length, 2_000);
    assert.equal(listed.at(-1).assistantResponse.length, 2_000);
    assert.match(listed[0].completedAt, /^\d{4}-\d\d-/);
    assert.deepEqual(await store.listCompletedTurns(FOREIGN_OWNER, SESSION), []);
    assert.deepEqual(await store.listCompletedTurns(OWNER, FOREIGN_SESSION), []);

    const history = await store.getCompletedHistory(OWNER, SESSION);
    assert.equal(history.length, 20);
    assert.deepEqual(history.slice(0, 2), [
      { role: 'user', content: 'learner-251' },
      { role: 'assistant', content: 'assistant-251' },
    ]);
    assert.deepEqual(history.slice(-2), [
      { role: 'user', content: 'x'.repeat(2_000) },
      { role: 'assistant', content: 'y'.repeat(2_000) },
    ]);
    assert.ok(history.every((entry) => entry.content.length <= 2_000));
    assert.deepEqual(await store.getCompletedHistory(FOREIGN_OWNER, SESSION), []);
    assert.deepEqual(await store.getCompletedHistory(OWNER, FOREIGN_SESSION), []);
  } finally {
    if (client) await client.end().catch(() => {});
    if (container) docker(['stop', container]);
  }
});

test('migration enforces unique turn identity and sequence, lease expiry and fenced text completion without audio columns', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/006_language_practice_turns.sql'), 'utf8');
  assert.match(migration, /UNIQUE \(session_id, client_turn_id\)/i);
  assert.match(migration, /UNIQUE \(session_id, sequence\)/i);
  assert.match(migration, /INTERVAL '30 seconds'/i);
  assert.match(migration, /status = 'FAILED'.*LANGUAGE_PRACTICE_LEASE_EXPIRED/is);
  assert.match(migration, /s\.owner_id = requested_owner/i);
  assert.match(migration, /requested_lease/i);
  assert.match(migration, /spanish_correction_evidence TEXT CHECK \(char_length\(spanish_correction_evidence\) <= 2000\)/i);
  assert.match(migration, /LEFT\(requested_spanish_correction_evidence, 2000\)/i);
  const complete = migration.split('CREATE FUNCTION lingualoop_complete_language_practice_turn')[1].split('CREATE FUNCTION lingualoop_fail_language_practice_turn')[0];
  const fail = migration.split('CREATE FUNCTION lingualoop_fail_language_practice_turn')[1];
  for (const fencedFunction of [complete, fail]) {
    assert.match(fencedFunction, /active_turn_lease_token = requested_lease/i);
    assert.doesNotMatch(fencedFunction, /active_turn_lease_expires_at\s*>/i);
  }
  assert.doesNotMatch(migration, /audio_(?:base64|buffer|bytes)|audio_data/i);
});
