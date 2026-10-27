const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { runLinguaLoopMigrations } = require('../../dist/db/migrate.js');

const DISPOSABLE_PASSWORD = 'disposable-postgres-test-password';
const IMAGE = 'postgres:16-alpine';
const MIGRATIONS_DIR = require('node:path').resolve(__dirname, '../../db/migrations');
const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const SESSION = '223e4567-e89b-42d3-a456-426614174000';

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

test('migration 010 adds report claims without changing existing report behavior', {
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
    assert.equal(await runLinguaLoopMigrations(client, MIGRATIONS_DIR), 17);
    await client.end();
    client = new Client(config);
    await client.connect();

    await client.query(
      "INSERT INTO lingualoop_accounts (id, issuer, subject, email, name, role) VALUES ($1::uuid, 'local', $1::uuid::text, $1::uuid::text || '@example.test', 'Test', 'student')",
      [OWNER],
    );
    await client.query(
      "INSERT INTO lingualoop_language_practice_sessions " +
        "(id, owner_id, level, topic, duration_minutes, expires_at) " +
        "VALUES ($1, $2, 'A1', 'travel', 5, now() + INTERVAL '1 hour')",
      [SESSION, OWNER],
    );

    const inserted = await client.query(
      'INSERT INTO lingualoop_language_practice_reports (session_id, content) VALUES ($1, $2) ' +
        'RETURNING session_id, content, generated_with_ai, created_at',
      [SESSION, JSON.stringify({ summary: 'Practice report' })],
    );
    assert.deepEqual(inserted.rows[0].content, { summary: 'Practice report' });
    assert.equal(inserted.rows[0].session_id, SESSION);
    assert.equal(inserted.rows[0].generated_with_ai, false);
    assert.ok(inserted.rows[0].created_at instanceof Date);

    await assert.rejects(client.query(
      'INSERT INTO lingualoop_language_practice_reports (session_id, content) VALUES ($1, $2)',
      [SESSION, JSON.stringify({ duplicate: true })],
    ));
    await assert.rejects(client.query(
      'INSERT INTO lingualoop_language_practice_reports (session_id, content) VALUES ($1, $2)',
      ['323e4567-e89b-42d3-a456-426614174000', JSON.stringify({})],
    ));
    await assert.rejects(client.query(
      'INSERT INTO lingualoop_language_practice_reports (session_id, content) VALUES ($1, $2)',
      ['323e4567-e89b-42d3-a456-426614174001', JSON.stringify('not an object')],
    ));
    const AI_SESSION = '423e4567-e89b-42d3-a456-426614174000';
    await client.query(
      "INSERT INTO lingualoop_language_practice_sessions " +
        "(id, owner_id, level, topic, duration_minutes, expires_at) " +
        "VALUES ($1, $2, 'A1', 'travel', 5, now() + INTERVAL '1 hour')",
      [AI_SESSION, OWNER],
    );
    const aiInserted = await client.query(
      'INSERT INTO lingualoop_language_practice_reports ' +
        '(session_id, content, generated_with_ai) VALUES ($1, $2, TRUE) ' +
        'RETURNING generated_with_ai',
      [AI_SESSION, JSON.stringify({})],
    );
    assert.equal(aiInserted.rows[0].generated_with_ai, true);

    const claimColumns = await client.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns " +
        "WHERE table_name = 'lingualoop_language_practice_report_claims' ORDER BY ordinal_position",
    );
    assert.deepEqual(claimColumns.rows, [
      { column_name: 'session_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'claim_token', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'lease_expires_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ]);
    const claim = await client.query(
      'INSERT INTO lingualoop_language_practice_report_claims ' +
        '(session_id, claim_token, lease_expires_at) VALUES ($1, $2, now() + INTERVAL \'1 minute\') ' +
        'RETURNING claim_token',
      [SESSION, '523e4567-e89b-42d3-a456-426614174000'],
    );
    assert.equal(claim.rows[0].claim_token, '523e4567-e89b-42d3-a456-426614174000');
    await assert.rejects(client.query(
      'INSERT INTO lingualoop_language_practice_report_claims ' +
        '(session_id, claim_token, lease_expires_at) VALUES ($1, $2, now())',
      [SESSION, '523e4567-e89b-42d3-a456-426614174001'],
    ));
    const reclaimed = await client.query(
      'INSERT INTO lingualoop_language_practice_report_claims ' +
        '(session_id, claim_token, lease_expires_at) VALUES ($1, $2, now() + INTERVAL \'1 minute\') ' +
        'ON CONFLICT (session_id) DO UPDATE SET claim_token = EXCLUDED.claim_token, ' +
        'lease_expires_at = EXCLUDED.lease_expires_at RETURNING claim_token',
      [SESSION, '523e4567-e89b-42d3-a456-426614174002'],
    );
    assert.equal(reclaimed.rows[0].claim_token, '523e4567-e89b-42d3-a456-426614174002');
    await assert.rejects(client.query(
      'INSERT INTO lingualoop_language_practice_report_claims ' +
        '(session_id, claim_token, lease_expires_at) VALUES ($1, $2, now())',
      ['323e4567-e89b-42d3-a456-426614174000', '523e4567-e89b-42d3-a456-426614174003'],
    ));
    const historical = await client.query(
      'SELECT session_id, generated_with_ai FROM lingualoop_language_practice_reports ' +
        'WHERE session_id = ANY($1::uuid[]) ORDER BY session_id',
      [[SESSION, AI_SESSION]],
    );
    assert.deepEqual(historical.rows.map((row) => row.generated_with_ai), [false, true]);
    await assert.rejects(client.query(
      'INSERT INTO lingualoop_language_practice_reports (session_id) VALUES ($1)',
      ['323e4567-e89b-42d3-a456-426614174003'],
    ));

    await client.query('DELETE FROM lingualoop_language_practice_sessions WHERE id = $1', [SESSION]);
    const remaining = await client.query(
      'SELECT session_id FROM lingualoop_language_practice_reports WHERE session_id = $1', [SESSION],
    );
    assert.deepEqual(remaining.rows, []);
    const remainingClaims = await client.query(
      'SELECT session_id FROM lingualoop_language_practice_report_claims WHERE session_id = $1', [SESSION],
    );
    assert.deepEqual(remainingClaims.rows, []);
  } finally {
    if (client) await client.end().catch(() => {});
    if (container) docker(['stop', container]);
  }
});
