const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Pool } = require('pg');
const {
  createLinguaLoopQueryExecutor,
  loadLinguaLoopPostgresConfig,
  LinguaLoopDatabaseConfigurationError,
  LinguaLoopDatabaseError,
  LinguaLoopPostgresProvider,
} = require('../../dist/db/postgres.js');

const PASSWORD = 'a'.repeat(64);
const CONFIG = { host: 'postgres', port: 5432, password: PASSWORD };

function fakePool({ result = { rows: [] }, error } = {}) {
  const calls = [];
  let endCount = 0;
  return {
    calls,
    get endCount() { return endCount; },
    pool: {
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        if (error) throw error;
        return result;
      },
      async end() { endCount += 1; },
    },
  };
}

test('runtime config defaults to private host and port and accepts only bounded explicit hosts', () => {
  assert.throws(() => loadLinguaLoopPostgresConfig({}), LinguaLoopDatabaseConfigurationError);
  for (const host of ['remote.example', 'postgres.example', 'https://postgres', 'localhost', '']) {
    assert.throws(() => loadLinguaLoopPostgresConfig({
      LINGUALOOP_DB_HOST: host,
      LINGUALOOP_DB_PASSWORD_FILE: '/dev/null',
    }), LinguaLoopDatabaseConfigurationError);
  }
  for (const port of ['0', '65536', '1.2', '5432x', '-1']) {
    assert.throws(() => loadLinguaLoopPostgresConfig({
      LINGUALOOP_DB_PORT: port,
      LINGUALOOP_DB_PASSWORD_FILE: '/dev/null',
    }), LinguaLoopDatabaseConfigurationError);
  }
});

test('password config requires an absolute regular non-symlink dedicated file path', () => {
  const packageManifest = path.resolve(__dirname, '../../package.json');
  const common = { LINGUALOOP_DB_PASSWORD_FILE: packageManifest };
  assert.throws(() => loadLinguaLoopPostgresConfig({
    ...common,
    LINGUALOOP_DB_HOST: 'postgres',
    LINGUALOOP_DB_PASSWORD: PASSWORD,
  }), LinguaLoopDatabaseConfigurationError);
  assert.throws(() => loadLinguaLoopPostgresConfig({
    ...common,
    LINGUALOOP_DB_HOST: 'postgres',
    LINGUALOOP_DB_PASSWORD_FILE: 'relative/password',
  }), LinguaLoopDatabaseConfigurationError);
  assert.throws(() => loadLinguaLoopPostgresConfig({
    LINGUALOOP_DB_HOST: 'postgres',
    LINGUALOOP_DB_PASSWORD_FILE: '/dev/stdin',
  }), LinguaLoopDatabaseConfigurationError);
});

test('executor rejects arbitrary hosts, invalid ports, and malformed credentials', () => {
  const invalid = [
    { ...CONFIG, host: '10.0.0.1' },
    { ...CONFIG, host: 'https://postgres' },
    { ...CONFIG, port: 0 },
    { ...CONFIG, port: 65536 },
    { ...CONFIG, password: 'A'.repeat(64) },
    { ...CONFIG, password: `${PASSWORD}\n` },
  ];
  for (const config of invalid) {
    assert.throws(() => createLinguaLoopQueryExecutor(config, fakePool().pool),
      LinguaLoopDatabaseConfigurationError);
  }
});

test('executor forwards SQL and bound parameters without interpolation', async () => {
  const fake = fakePool({ result: { rows: [{ id: 'row' }] } });
  const executor = createLinguaLoopQueryExecutor(CONFIG, fake.pool);
  const parameters = ['google', 'subject; DROP TABLE lingualoop_accounts'];
  const result = await executor.query('SELECT $1, $2', parameters);
  assert.deepEqual(result, { rows: [{ id: 'row' }] });
  assert.deepEqual(fake.calls, [{ sql: 'SELECT $1, $2', parameters }]);
  assert.notEqual(fake.calls[0].parameters, parameters);
  await executor.close();
  assert.equal(fake.endCount, 0, 'injected pool remains caller-owned');
});

test('query and pool failures expose only a generic sanitized error', async () => {
  const secret = 'database-password-must-not-leak';
  const fake = fakePool({ error: new Error(`connect failed: ${secret}`) });
  const executor = createLinguaLoopQueryExecutor(CONFIG, fake.pool);
  await assert.rejects(executor.query('SELECT 1', []), (error) => {
    assert.equal(error.name, 'LinguaLoopDatabaseError');
    assert.equal(error.message, 'LinguaLoop database operation failed.');
    assert.equal(error.stack.includes(secret), false);
    return true;
  });
});

test('owned pool idle-client error event is consumed without logging or crashing', async () => {
  const originalOn = Pool.prototype.on;
  let ownedPool;
  let executor;
  try {
    Pool.prototype.on = function (event, listener) {
      const result = originalOn.call(this, event, listener);
      if (event === 'error') ownedPool = this;
      return result;
    };
    executor = createLinguaLoopQueryExecutor(CONFIG);
    Pool.prototype.on = originalOn;

    assert.ok(ownedPool, 'captures the constructed owned pool without connecting');
    assert.doesNotThrow(() => ownedPool.emit('error', new Error('raw password-like detail')));
  } finally {
    Pool.prototype.on = originalOn;
    if (executor) await executor.close();
  }
});

test('owned pool close is idempotent and prevents later queries', async () => {
  const executor = createLinguaLoopQueryExecutor(CONFIG);
  await executor.close();
  await executor.close();
  await assert.rejects(executor.query('SELECT 1', []), LinguaLoopDatabaseError);
});

test('Nest provider delegates queries and closes its owned executor on module shutdown', async () => {
  const calls = [];
  let closeCount = 0;
  const provider = new LinguaLoopPostgresProvider({
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [{ value: 1 }] };
    },
    async close() { closeCount += 1; },
  });

  assert.deepEqual(await provider.query('SELECT 1', []), { rows: [{ value: 1 }] });
  assert.deepEqual(calls, [{ sql: 'SELECT 1', parameters: [] }]);
  await provider.onModuleDestroy();
  assert.equal(closeCount, 1);
});
