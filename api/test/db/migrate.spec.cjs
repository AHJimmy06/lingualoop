const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { runLinguaLoopMigrations } = require('../../dist/db/migrate.js');

const migrationsDir = path.resolve(__dirname, '../../db/migrations');
const names = [
  '001_owner_identity.sql', '002_oauth_state.sql',
  '003_auth_sessions.sql', '004_refresh_rotation.sql',
  '005_language_practice_sessions.sql', '006_language_practice_turns.sql',
  '007_language_practice_turn_lease.sql', '008_language_practice_reports.sql',
];
const lock = 'lingualoop:schema-migrations';
const migrationSql = names.map((name) => require('node:fs').readFileSync(path.join(migrationsDir, name), 'utf8'));
const hashes = migrationSql.map((sql) => createHash('sha256').update(sql).digest('hex'));

function fakeClient({ ledger = false, applied = [], collision = [], failOnSql } = {}) {
  const calls = [];
  let ended = 0;
  return {
    calls,
    get ended() { return ended; },
    client: {
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        if (failOnSql && sql === failOnSql) throw new Error('private database diagnostic');
        if (sql.startsWith('SELECT to_regclass')) return { rows: [{ ledger: ledger ? 'lingualoop_schema_migrations' : null }] };
        if (sql.startsWith('SELECT c.relname')) return { rows: collision };
        if (sql.startsWith('SELECT version, checksum')) return { rows: applied };
        return { rows: [] };
      },
      async end() { ended += 1; },
    },
  };
}

test('applies ordered SQL under LinguaLoop advisory lock and closes the client', async () => {
  const fake = fakeClient();
  assert.equal(await runLinguaLoopMigrations(fake.client, migrationsDir), 8);
  assert.deepEqual(fake.calls[0].sql, 'BEGIN');
  assert.deepEqual(fake.calls[1], {
    sql: 'SELECT pg_advisory_xact_lock(hashtext($1))', parameters: [lock],
  });
  const sqlCalls = fake.calls.filter((call) => migrationSql.includes(call.sql));
  assert.deepEqual(sqlCalls.map((call) => call.sql), migrationSql);
  assert.ok(fake.calls.some((call) => call.sql === 'COMMIT'));
  assert.equal(fake.ended, 1);
});

test('an unexpected sequential migration is rejected before any database query', async () => {
  const fsPromises = require('node:fs').promises;
  const originalReaddir = fsPromises.readdir;
  const fake = fakeClient();
  fsPromises.readdir = async () => [...names, '007_surprise.sql'].map((name) => ({ name }));
  try {
    await assert.rejects(runLinguaLoopMigrations(fake.client, migrationsDir), /LinguaLoop migration failed/);
  } finally {
    fsPromises.readdir = originalReaddir;
  }
  assert.deepEqual(fake.calls, [], 'allowlist validation must happen before BEGIN');
  assert.equal(fake.ended, 1);
});

test('a complete ledger rerun is a no-op', async () => {
  const fake = fakeClient({
    ledger: true,
    applied: names.map((version, index) => ({ version, checksum: hashes[index] })),
  });
  assert.equal(await runLinguaLoopMigrations(fake.client, migrationsDir), 0);
  assert.equal(fake.calls.filter((call) => names.some((name) => call.sql.includes(name))).length, 0);
  assert.ok(fake.calls.some((call) => call.sql === 'COMMIT'));
  assert.equal(fake.ended, 1);
});

test('checksum drift rolls back and reports only sanitized error', async () => {
  const fake = fakeClient({ ledger: true, applied: [{ version: names[0], checksum: '0'.repeat(64) }] });
  await assert.rejects(runLinguaLoopMigrations(fake.client, migrationsDir), (error) => {
    assert.equal(error.message, 'LinguaLoop migration failed.');
    assert.equal(error.message.includes('0'.repeat(64)), false);
    return true;
  });
  assert.ok(fake.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.equal(fake.ended, 1);
});

test('an absent ledger with existing LinguaLoop schema objects fails without applying SQL', async () => {
  const fake = fakeClient({ collision: [{ name: 'lingualoop_accounts' }] });
  await assert.rejects(runLinguaLoopMigrations(fake.client, migrationsDir), /LinguaLoop migration failed/);
  const migrationQueries = fake.calls.filter((call) => migrationSql.includes(call.sql));
  assert.deepEqual(migrationQueries, [], 'collision must be rejected before the first migration SQL');
  const collisionQuery = fake.calls.findIndex((call) => call.sql.startsWith('SELECT c.relname'));
  const rollbackQuery = fake.calls.findIndex((call) => call.sql === 'ROLLBACK');
  assert.ok(collisionQuery >= 0);
  assert.ok(rollbackQuery > collisionQuery);
  assert.equal(fake.calls.some((call) => call.sql.includes('CREATE TABLE lingualoop_schema_migrations')), false);
  assert.equal(fake.ended, 1);
});

test('SQL failure rolls back, closes client, and does not reveal database diagnostics', async () => {
  const secret = 'private database diagnostic';
  const fake = fakeClient({ failOnSql: require('node:fs').readFileSync(path.join(migrationsDir, names[0]), 'utf8') });
  await assert.rejects(runLinguaLoopMigrations(fake.client, migrationsDir), (error) => {
    assert.equal(error.message, 'LinguaLoop migration failed.');
    assert.equal(error.stack.includes(secret), false);
    return true;
  });
  assert.ok(fake.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.equal(fake.ended, 1);
});
