const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { runLinguaLoopMigrations } = require('../../dist/db/migrate.js');

const migrationsDir = path.resolve(__dirname, '../../db/migrations');
const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const FOREIGN_OWNER = '123e4567-e89b-42d3-a456-426614174001';
const SESSION = '223e4567-e89b-42d3-a456-426614174000';
const FIRST_CLIENT_TURN = '323e4567-e89b-42d3-a456-426614174000';
const SECOND_CLIENT_TURN = '323e4567-e89b-42d3-a456-426614174001';
const DISPOSABLE_PASSWORD = 'disposable-postgres-test-password';
const IMAGE = 'postgres:16-alpine';

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

test('five-minute lease serializes later turns and preserves replay, owner checks, and fencing', {
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
    client = await waitForPostgres({
      host: '127.0.0.1', port: Number(publishedPort), database: 'lingualoop_test',
      user: 'postgres', password: DISPOSABLE_PASSWORD, connectionTimeoutMillis: 1_000,
    });
    await runLinguaLoopMigrations(client, migrationsDir);
    client = new Client({
      host: '127.0.0.1', port: Number(publishedPort), database: 'lingualoop_test',
      user: 'postgres', password: DISPOSABLE_PASSWORD,
    });
    await client.connect();

    await client.query(
      "INSERT INTO lingualoop_accounts (id, issuer, subject) VALUES ($1, 'google', 'lease-test-owner')",
      [OWNER],
    );
    await client.query(
      "INSERT INTO lingualoop_language_practice_sessions " +
        "(id, owner_id, level, topic, duration_minutes, expires_at) " +
        "VALUES ($1, $2, 'A1', 'travel', 5, clock_timestamp() + INTERVAL '1 hour')",
      [SESSION, OWNER],
    );

    const admitted = (await client.query(
      'SELECT * FROM lingualoop_reserve_language_practice_turn($1, $2, $3)',
      [OWNER, SESSION, FIRST_CLIENT_TURN],
    )).rows[0];
    assert.equal(admitted.outcome, 'admitted');
    assert.equal(admitted.turn_sequence, 1);
    assert.ok(admitted.lease_token);
    assert.ok(admitted.lease_expires_at);
    const remaining = (await client.query(
      'SELECT EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) AS seconds',
      [admitted.lease_expires_at],
    )).rows[0].seconds;
    assert.ok(Number(remaining) <= 300 && Number(remaining) > 295,
      `returned lease expiry should be about five minutes away, got ${remaining}s`);

    const replay = (await client.query(
      'SELECT * FROM lingualoop_reserve_language_practice_turn($1, $2, $3)',
      [OWNER, SESSION, FIRST_CLIENT_TURN],
    )).rows[0];
    assert.equal(replay.outcome, 'replay');
    assert.equal(replay.turn_id, admitted.turn_id);
    assert.equal(replay.lease_token, admitted.lease_token);
    assert.equal(new Date(replay.lease_expires_at).toISOString(),
      new Date(admitted.lease_expires_at).toISOString());

    const serialized = (await client.query(
      'SELECT * FROM lingualoop_reserve_language_practice_turn($1, $2, $3)',
      [OWNER, SESSION, SECOND_CLIENT_TURN],
    )).rows[0];
    assert.equal(serialized.outcome, 'turn_in_progress');

    const foreignReplay = (await client.query(
      'SELECT * FROM lingualoop_reserve_language_practice_turn($1, $2, $3)',
      [FOREIGN_OWNER, SESSION, FIRST_CLIENT_TURN],
    )).rows[0];
    assert.equal(foreignReplay.outcome, 'not_found', 'owner validation precedes idempotent replay');

    const wrongOwnerCompletion = await client.query(
      'SELECT lingualoop_complete_language_practice_turn($1, $2, $3, $4, $5, $6, $7) AS completed',
      [FOREIGN_OWNER, SESSION, admitted.turn_id, admitted.lease_token, 'hello', 'Welcome.', '{}'],
    );
    assert.equal(wrongOwnerCompletion.rows[0].completed, false);
    const wrongLeaseCompletion = await client.query(
      'SELECT lingualoop_complete_language_practice_turn($1, $2, $3, $4, $5, $6, $7) AS completed',
      [OWNER, SESSION, admitted.turn_id, SECOND_CLIENT_TURN, 'hello', 'Welcome.', '{}'],
    );
    assert.equal(wrongLeaseCompletion.rows[0].completed, false);
    await client.query(
      "UPDATE lingualoop_language_practice_sessions " +
        "SET active_turn_lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
      [SESSION],
    );
    const nextTurn = (await client.query(
      'SELECT * FROM lingualoop_reserve_language_practice_turn($1, $2, $3)',
      [OWNER, SESSION, SECOND_CLIENT_TURN],
    )).rows[0];
    assert.equal(nextTurn.outcome, 'admitted');
    assert.equal(nextTurn.turn_sequence, 2);
    assert.ok(nextTurn.lease_token);
    assert.notEqual(nextTurn.lease_token, admitted.lease_token);
    const nextRemaining = (await client.query(
      'SELECT EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) AS seconds',
      [nextTurn.lease_expires_at],
    )).rows[0].seconds;
    assert.ok(Number(nextRemaining) <= 300 && Number(nextRemaining) > 295,
      `reclaimed turn should receive a new five-minute lease, got ${nextRemaining}s`);

    const expiredTurn = await client.query(
      'SELECT status, failure_code FROM lingualoop_language_practice_turns WHERE id = $1',
      [admitted.turn_id],
    );
    assert.deepEqual(expiredTurn.rows[0], {
      status: 'FAILED', failure_code: 'LANGUAGE_PRACTICE_LEASE_EXPIRED',
    });
    const staleCompletion = await client.query(
      'SELECT lingualoop_complete_language_practice_turn($1, $2, $3, $4, $5, $6, $7) AS completed',
      [OWNER, SESSION, admitted.turn_id, admitted.lease_token, 'late text', 'stale response', '{}'],
    );
    assert.equal(staleCompletion.rows[0].completed, false,
      'the previous owner token must not complete after lease reclamation');

    const oldTurnReplay = (await client.query(
      'SELECT * FROM lingualoop_reserve_language_practice_turn($1, $2, $3)',
      [OWNER, SESSION, FIRST_CLIENT_TURN],
    )).rows[0];
    assert.equal(oldTurnReplay.outcome, 'replay');
    assert.equal(oldTurnReplay.turn_id, admitted.turn_id);
    assert.equal(oldTurnReplay.turn_status, 'FAILED');
    assert.equal(oldTurnReplay.failure_code, 'LANGUAGE_PRACTICE_LEASE_EXPIRED');
    assert.equal(oldTurnReplay.lease_token, null);
    assert.equal(oldTurnReplay.lease_expires_at, null);
    const turnCount = await client.query(
      'SELECT COUNT(*)::integer AS count FROM lingualoop_language_practice_turns WHERE session_id = $1',
      [SESSION],
    );
    assert.equal(turnCount.rows[0].count, 2, 'replaying the expired client turn must not insert another turn');
  } finally {
    if (client) await client.end().catch(() => {});
    if (container) docker(['stop', container]);
  }
});
