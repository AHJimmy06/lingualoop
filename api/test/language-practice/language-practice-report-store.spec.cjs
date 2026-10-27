const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const { runLinguaLoopMigrations } = require('../../dist/db/migrate.js');
const { createLinguaLoopQueryExecutor } = require('../../dist/db/postgres.js');
const {
  LanguagePracticeReportAdmissionError,
  LanguagePracticeReportStore,
  LanguagePracticeReportStoreError,
} = require('../../dist/language-practice/language-practice-report-store.js');

const PASSWORD = 'disposable-postgres-test-password';
const IMAGE = 'postgres:16-alpine';
const MIGRATIONS_DIR = require('node:path').resolve(__dirname, '../../db/migrations');
const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_OWNER = '123e4567-e89b-42d3-a456-426614174001';
const SESSION = '223e4567-e89b-42d3-a456-426614174000';
const LEASE_SESSION = '223e4567-e89b-42d3-a456-426614174001';
const ACTIVE_SESSION = '223e4567-e89b-42d3-a456-426614174002';
const TURN = '323e4567-e89b-42d3-a456-426614174000';
const LEASE = '423e4567-e89b-42d3-a456-426614174000';

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Disposable PostgreSQL Docker command failed: ${args[0]}`);
  return result.stdout.trim();
}

async function waitForPostgres(config) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new Client(config);
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready.');
}

test('report store is owner-scoped, deterministic, immutable, and closes stale leases in disposable PostgreSQL', {
  timeout: 180_000,
}, async () => {
  let container;
  let client;
  let pool;
  let executor;
  try {
    container = docker([
      'run', '--rm', '--detach', '--publish', '127.0.0.1::5432',
      '--env', `POSTGRES_PASSWORD=${PASSWORD}`,
      '--env', 'POSTGRES_DB=lingualoop_test', IMAGE,
    ]);
    const port = Number(docker(['port', container, '5432/tcp']).split(':').at(-1));
    assert.ok(Number.isInteger(port) && port > 0);
    const config = {
      host: '127.0.0.1', port, database: 'lingualoop_test', user: 'postgres',
      password: PASSWORD, connectionTimeoutMillis: 1_000,
    };
    client = await waitForPostgres(config);
    assert.equal(await runLinguaLoopMigrations(client, MIGRATIONS_DIR), 17);
    await client.end();
    client = new Client(config);
    await client.connect();
    for (const [id, subject] of [[OWNER, 'report-owner'], [OTHER_OWNER, 'other-owner']]) {
      await client.query("INSERT INTO lingualoop_accounts (id, issuer, subject, email, name, role) VALUES ($1::uuid, 'local', $1::uuid::text, $1::uuid::text || '@example.test', $2, 'student')", [id, subject]);
    }
    await client.query(
      "INSERT INTO lingualoop_language_practice_sessions (id, owner_id, level, topic, duration_minutes, status, expires_at) " +
      "VALUES ($1, $2, 'A1', 'travel', 5, 'COMPLETED', now() + interval '1 hour'), " +
      "($3, $2, 'A1', 'travel', 5, 'ACTIVE', now() - interval '1 second'), " +
      "($4, $2, 'A1', 'travel', 5, 'ACTIVE', now() + interval '1 hour')",
      [SESSION, OWNER, LEASE_SESSION, ACTIVE_SESSION],
    );
    await client.query(
      "INSERT INTO lingualoop_language_practice_turns (id, session_id, client_turn_id, sequence, status, transcript, assistant_response, completed_at, spanish_correction_evidence) " +
      "VALUES ($1, $2, $3, 1, 'COMPLETED', 'I goed home.', 'Try again.', now(), $4)",
      [TURN, SESSION, '523e4567-e89b-42d3-a456-426614174000', JSON.stringify({ correctedPhrase: 'I went home.', feedback: 'Use the past tense.' })],
    );
    await client.query(
      "UPDATE lingualoop_language_practice_sessions SET active_turn_lease_token = $2, active_turn_lease_expires_at = now() + interval '1 hour' WHERE id = $1",
      [LEASE_SESSION, LEASE],
    );
    await client.query(
      "INSERT INTO lingualoop_language_practice_turns (id, session_id, client_turn_id, sequence, status, lease_token) " +
      "VALUES ($1, $2, $3, 1, 'PROCESSING', $4)",
      ['623e4567-e89b-42d3-a456-426614174000', LEASE_SESSION, '723e4567-e89b-42d3-a456-426614174000', LEASE],
    );

    pool = new Pool(config);
    executor = createLinguaLoopQueryExecutor({ host: '127.0.0.1', port, password: 'a'.repeat(64) }, pool);
    const store = new LanguagePracticeReportStore(executor);
    const claimSession = '223e4567-e89b-42d3-a456-426614174004';
    const emptyClaimSession = '223e4567-e89b-42d3-a456-426614174005';
    const failureSession = '223e4567-e89b-42d3-a456-426614174006';
    const staleClaimSession = '223e4567-e89b-42d3-a456-426614174007';
    await client.query(
      "INSERT INTO lingualoop_language_practice_sessions (id, owner_id, level, topic, duration_minutes, status, expires_at) " +
      "VALUES ($1, $2, 'B1', 'travel', 5, 'COMPLETED', now() + interval '1 hour'), " +
      "($3, $2, 'A1', 'travel', 5, 'EXPIRED', now() - interval '1 hour'), " +
      "($4, $2, 'A1', 'travel', 5, 'COMPLETED', now()), " +
      "($5, $2, 'A1', 'travel', 5, 'COMPLETED', now())",
      [claimSession, OWNER, emptyClaimSession, failureSession, staleClaimSession],
    );
    await client.query(
      "INSERT INTO lingualoop_language_practice_turns (id, session_id, client_turn_id, sequence, status, transcript, assistant_response, completed_at, spanish_correction_evidence) " +
      "VALUES ($1, $2, $3, 1, 'COMPLETED', 'We ate well.', 'Good.', now(), NULL), " +
      "($4, $5, $6, 1, 'COMPLETED', 'They are kind.', 'Good.', now(), NULL), " +
      "($7, $8, $9, 1, 'COMPLETED', 'I enjoy music.', 'Good.', now(), NULL)",
      ['823e4567-e89b-42d3-a456-426614174000', claimSession, '923e4567-e89b-42d3-a456-426614174000',
        '823e4567-e89b-42d3-a456-426614174001', staleClaimSession, '923e4567-e89b-42d3-a456-426614174001',
        '823e4567-e89b-42d3-a456-426614174002', failureSession, '923e4567-e89b-42d3-a456-426614174002'],
    );
    await store.getOrCreate(OWNER, SESSION);
    const historical = await store.beginAiReport(OWNER, SESSION);
    assert.equal(historical.kind, 'existing');
    assert.equal(historical.report.generatedWithAi, false);
    assert.deepEqual(historical.report, await store.getOrCreate(OWNER, SESSION));

    const emptyBegin = await store.beginAiReport(OWNER, emptyClaimSession);
    assert.equal(emptyBegin.kind, 'no_evidence');
    assert.equal(emptyBegin.report.generatedWithAi, false);
    assert.equal(emptyBegin.report.corrections.length, 0);
    assert.equal((await client.query(
      'SELECT count(*)::int AS count FROM lingualoop_language_practice_report_claims WHERE session_id = $1',
      [emptyClaimSession],
    )).rows[0].count, 0);

    const beginnings = await Promise.all([
      store.beginAiReport(OWNER, claimSession), store.beginAiReport(OWNER, claimSession),
    ]);
    assert.equal(beginnings.filter((value) => value.kind === 'claimed').length, 1);
    assert.equal(beginnings.filter((value) => value.kind === 'busy').length, 1);
    const claimed = beginnings.find((value) => value.kind === 'claimed');
    assert.equal(claimed.turns.length, 1);
    assert.equal(claimed.topic, 'Travel');
    assert.equal(claimed.level, 'B1');
    await assert.rejects(store.beginAiReport(OTHER_OWNER, claimSession), (error) =>
      error instanceof LanguagePracticeReportAdmissionError && error.reason === 'not_found');

    const failedClaim = await store.beginAiReport(OWNER, failureSession);
    assert.equal(failedClaim.kind, 'claimed');
    assert.equal(await store.releaseAiReport(OWNER, failureSession, failedClaim.token), true);
    const retriedClaim = await store.beginAiReport(OWNER, failureSession);
    assert.equal(retriedClaim.kind, 'claimed');
    assert.notEqual(retriedClaim.token, failedClaim.token);

    const staleClaim = await store.beginAiReport(OWNER, staleClaimSession);
    assert.equal(staleClaim.kind, 'claimed');
    await client.query(
      'UPDATE lingualoop_language_practice_report_claims SET lease_expires_at = now() - interval \'1 second\' WHERE session_id = $1',
      [staleClaimSession],
    );
    const replacement = await store.beginAiReport(OWNER, staleClaimSession);
    assert.equal(replacement.kind, 'claimed');
    assert.notEqual(replacement.token, staleClaim.token);
    const aiContent = {
      summary: 'A clear practice session.', corrections: [], strengths: ['Clear expression.'], recommendations: ['Keep practicing.'],
    };
    assert.equal(await store.finalizeAiReport(OWNER, staleClaimSession, staleClaim.token, aiContent), null);
    const finalized = await store.finalizeAiReport(OWNER, staleClaimSession, replacement.token, aiContent);
    assert.equal(finalized.generatedWithAi, true);
    assert.deepEqual((await store.beginAiReport(OWNER, staleClaimSession)), { kind: 'existing', report: finalized });

    await assert.rejects(store.getOrCreate(OTHER_OWNER, SESSION), (error) =>
      error instanceof LanguagePracticeReportAdmissionError && error.reason === 'not_found');
    await assert.rejects(store.getOrCreate(OWNER, ACTIVE_SESSION), (error) =>
      error instanceof LanguagePracticeReportAdmissionError && error.reason === 'not_closed');

    const [first, concurrent] = await Promise.all([
      store.getOrCreate(OWNER, SESSION), store.getOrCreate(OWNER, SESSION),
    ]);
    assert.deepEqual(first, concurrent);
    assert.equal(first.sessionId, SESSION);
    assert.equal(concurrent.sessionId, SESSION);
    assert.equal(first.generatedWithAi, false);
    assert.ok(first.createdAt);
    assert.equal(first.corrections.length, 1);
    assert.deepEqual(first.corrections[0], {
      sequence: 1, original: 'I goed home.', correctedPhrase: 'I went home.', explanation: 'Use the past tense.',
    });
    const durable = await client.query(
      'SELECT content, generated_with_ai, created_at FROM lingualoop_language_practice_reports WHERE session_id = $1', [SESSION],
    );
    assert.equal(durable.rows.length, 1);
    assert.equal(durable.rows[0].generated_with_ai, false);
    assert.equal(durable.rows[0].created_at.toISOString(), first.createdAt);
    const repeated = await store.getOrCreate(OWNER, SESSION);
    assert.equal(repeated.sessionId, SESSION);
    assert.deepEqual(repeated, first);

    await client.query(
      'UPDATE lingualoop_language_practice_reports SET content = $2::jsonb WHERE session_id = $1',
      [SESSION, JSON.stringify({
        summary: 'do-not-leak-this-corruption', corrections: [], strengths: ['one', 'two', 'three', 'four'],
        recommendations: [],
      })],
    );
    await assert.rejects(store.getOrCreate(OWNER, SESSION), (error) => {
      assert.ok(error instanceof LanguagePracticeReportStoreError);
      assert.equal(error.message, 'Language practice report store operation failed.');
      assert.doesNotMatch(error.message, /do-not-leak-this-corruption/);
      return true;
    });

    const noTurnsSession = '223e4567-e89b-42d3-a456-426614174003';
    await client.query(
      "INSERT INTO lingualoop_language_practice_sessions (id, owner_id, level, topic, duration_minutes, status, expires_at) " +
      "VALUES ($1, $2, 'A1', 'travel', 5, 'EXPIRED', now() - interval '1 second')", [noTurnsSession, OWNER],
    );
    const empty = await store.getOrCreate(OWNER, noTurnsSession);
    assert.deepEqual(empty.corrections, []);
    assert.match(empty.summary, /without completed responses/);

    const stale = await store.getOrCreate(OWNER, LEASE_SESSION);
    assert.equal(stale.generatedWithAi, false);
    const closed = await client.query(
      'SELECT status, active_turn_lease_token, active_turn_lease_expires_at FROM lingualoop_language_practice_sessions WHERE id = $1',
      [LEASE_SESSION],
    );
    assert.equal(closed.rows[0].status, 'EXPIRED');
    assert.equal(closed.rows[0].active_turn_lease_token, null);
    assert.equal(closed.rows[0].active_turn_lease_expires_at, null);
    const failed = await client.query(
      'SELECT status, failure_code, lease_token FROM lingualoop_language_practice_turns WHERE session_id = $1', [LEASE_SESSION],
    );
    assert.deepEqual(failed.rows[0], {
      status: 'FAILED', failure_code: 'LANGUAGE_PRACTICE_SESSION_CLOSED', lease_token: null,
    });
    const lateCompletion = await client.query(
      'SELECT lingualoop_complete_language_practice_turn($1, $2, $3, $4, $5, $6, $7) AS completed',
      [OWNER, LEASE_SESSION, '623e4567-e89b-42d3-a456-426614174000', LEASE, 'late text', 'late response', '{}'],
    );
    assert.equal(lateCompletion.rows[0].completed, false);
  } finally {
    if (executor) await executor.close();
    if (pool) await pool.end().catch(() => {});
    if (client) await client.end().catch(() => {});
    if (container) docker(['stop', container]);
  }
});
