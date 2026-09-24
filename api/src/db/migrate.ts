import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadLinguaLoopPostgresConfig } from './postgres';

const LOCK_KEY = 'lingualoop:schema-migrations';
const LEDGER = 'lingualoop_schema_migrations';
const MIGRATION_ERROR = 'LinguaLoop migration failed.';
const MAX_MIGRATION_BYTES = 64 * 1024;
const REQUIRED_MIGRATIONS = [
  '001_owner_identity.sql', '002_oauth_state.sql',
  '003_auth_sessions.sql', '004_refresh_rotation.sql',
  '005_language_practice_sessions.sql', '006_language_practice_turns.sql',
  '007_language_practice_turn_lease.sql',
];

export interface MigrationClient {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

interface MigrationFile { name: string; sql: string; checksum: string; }

async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const names = entries.filter((entry) => entry.name.endsWith('.sql')).map((entry) => entry.name);
  const numbered = names.map((name) => {
    const match = /^(\d{3,})_[a-z0-9][a-z0-9_-]*\.sql$/.exec(name);
    if (!match) throw new Error();
    return { name, number: Number(match[1]) };
  }).sort((left, right) => left.number - right.number);
  if (numbered.length !== REQUIRED_MIGRATIONS.length ||
      numbered.some((item, index) => item.number !== index + 1 ||
        item.name !== REQUIRED_MIGRATIONS[index])) throw new Error();

  const migrations: MigrationFile[] = [];
  for (const { name } of numbered) {
    const file = await fs.open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_MIGRATION_BYTES) throw new Error();
      const boundedContents = Buffer.alloc(MAX_MIGRATION_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < boundedContents.length) {
        const result = await file.read(
          boundedContents, bytesRead, boundedContents.length - bytesRead, bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_MIGRATION_BYTES) throw new Error();
      const contents = boundedContents.subarray(0, bytesRead);
      migrations.push({
        name, sql: contents.toString('utf8'),
        checksum: createHash('sha256').update(contents).digest('hex'),
      });
    } finally {
      await file.close();
    }
  }
  return migrations;
}

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  if (!result || !Array.isArray(result.rows)) throw new Error();
  return result.rows as T[];
}

export async function runLinguaLoopMigrations(
  client: MigrationClient,
  migrationsDir: string,
): Promise<number> {
  let transactionStarted = false;
  try {
    const migrations = await loadMigrations(migrationsDir);
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);

    const ledgerExists = rowsOf<{ ledger: string | null }>(
      await client.query('SELECT to_regclass($1) AS ledger', [LEDGER]),
    )[0]?.ledger;
    if (!ledgerExists) {
      const collisions = rowsOf<{ name: string }>(await client.query(
        "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND left(c.relname, 11) = 'lingualoop_' " +
        "AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') LIMIT 1",
      ));
      if (collisions.length) throw new Error();
      await client.query(
        `CREATE TABLE ${LEDGER} (version TEXT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
    }

    const applied = rowsOf<{ version: string; checksum: string }>(await client.query(
      `SELECT version, checksum FROM ${LEDGER} ORDER BY version`,
    ));
    if (applied.length > migrations.length || applied.some((row, index) =>
      row.version !== migrations[index]?.name)) throw new Error();
    const checksums = new Map(applied.map((row) => [row.version, row.checksum.trim()]));
    for (const migration of migrations) {
      const previous = checksums.get(migration.name);
      if (previous !== undefined) {
        if (previous !== migration.checksum) throw new Error();
        continue;
      }
      await client.query(migration.sql);
      await client.query(`INSERT INTO ${LEDGER} (version, checksum) VALUES ($1, $2)`, [
        migration.name, migration.checksum,
      ]);
      checksums.set(migration.name, migration.checksum);
    }
    await client.query('COMMIT');
    transactionStarted = false;
    return migrations.length - applied.length;
  } catch {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch { /* Keep the failure sanitized. */ }
    }
    throw new Error(MIGRATION_ERROR);
  } finally {
    try { await client.end(); } catch { /* Do not expose driver details. */ }
  }
}

async function main(): Promise<void> {
  let client: Client | undefined;
  try {
    const config = loadLinguaLoopPostgresConfig();
    client = new Client({
      host: config.host, port: config.port, database: 'lingualoop',
      user: 'lingualoop', password: config.password,
    });
    await client.connect();
    const connectedClient = client;
    client = undefined;
    const count = await runLinguaLoopMigrations(connectedClient, join(process.cwd(), 'db/migrations'));
    console.log(`LinguaLoop migrations complete (${count} applied).`);
  } catch {
    if (client) {
      try { await client.end(); } catch { /* Keep output sanitized. */ }
    }
    console.error(MIGRATION_ERROR);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
