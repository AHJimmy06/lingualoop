const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const { runLinguaLoopMigrations } = require('../../dist/db/migrate.js');
const { createLinguaLoopQueryExecutor } = require('../../dist/db/postgres.js');
const { LanguagePracticeSessionStore } = require('../../dist/language-practice/language-practice-session-store.js');

const PASSWORD = 'disposable-postgres-test-password';
const IMAGE = 'postgres:16-alpine';
const MIGRATIONS_DIR = require('node:path').resolve(__dirname, '../../db/migrations');
const OWNER = '123e4567-e89b-42d3-a456-426614174000';

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

test('session creation binds an owner and stores requested duration in disposable PostgreSQL', {
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
    await client.query("INSERT INTO lingualoop_accounts (id, issuer, subject, email, name, role) VALUES ($1::uuid, 'local', $1::uuid::text, $1::uuid::text || '@example.test', 'Test', 'student')", [OWNER]);

    pool = new Pool(config);
    executor = createLinguaLoopQueryExecutor({ host: '127.0.0.1', port, password: 'a'.repeat(64) }, pool);
    const store = new LanguagePracticeSessionStore(executor);
    const created = await store.createSession(OWNER, {
      level: 'B1', topic: 'travel', durationMinutes: 10,
    });

    assert.equal(created.durationMinutes, 10);
    assert.equal(created.remainingMs, 600_000);
    assert.equal(Date.parse(created.expiresAt) - Date.parse(created.startedAt), 600_000);
    const stored = await client.query(
      'SELECT owner_id, duration_minutes, started_at, expires_at FROM lingualoop_language_practice_sessions WHERE id = $1',
      [created.id],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].owner_id, OWNER);
    assert.equal(stored.rows[0].duration_minutes, 10);
    assert.equal(stored.rows[0].expires_at.getTime() - stored.rows[0].started_at.getTime(), 600_000);
  } finally {
    if (executor) await executor.close();
    if (pool) await pool.end().catch(() => {});
    if (client) await client.end().catch(() => {});
    if (container) docker(['stop', container]);
  }
});
