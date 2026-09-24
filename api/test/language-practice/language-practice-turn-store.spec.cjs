const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
