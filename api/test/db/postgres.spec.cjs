const test = require('node:test');
const assert = require('node:assert/strict');
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

function transactionPool({ fail = [] } = {}) {
  const calls = [];
  let releaseCount = 0;
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (fail.includes(sql)) throw new Error(`sensitive ${sql} failure`);
      return { rows: [{ value: 1 }] };
    },
    release() { releaseCount += 1; },
  };
  return {
    calls,
    get releaseCount() { return releaseCount; },
    pool: {
      async query() { throw new Error('pool query must not be used in transaction'); },
      async connect() { return client; },
      async end() {},
    },
  };
}

test('runtime config defaults to private host and port and accepts only bounded explicit hosts', () => {
  assert.throws(() => loadLinguaLoopPostgresConfig({}), LinguaLoopDatabaseConfigurationError);
  for (const host of ['remote.example', 'postgres.example', 'https://postgres', 'localhost', '']) {
    assert.throws(() => loadLinguaLoopPostgresConfig({
      LINGUALOOP_DB_HOST: host,
      LINGUALOOP_DB_PASSWORD: PASSWORD,
    }), LinguaLoopDatabaseConfigurationError);
  }
  for (const port of ['0', '65536', '1.2', '5432x', '-1']) {
    assert.throws(() => loadLinguaLoopPostgresConfig({
      LINGUALOOP_DB_PORT: port,
      LINGUALOOP_DB_PASSWORD: PASSWORD,
    }), LinguaLoopDatabaseConfigurationError);
  }
});

test('password config reads a 64-character lowercase hex value from the environment', () => {
  assert.deepEqual(loadLinguaLoopPostgresConfig({
    LINGUALOOP_DB_PASSWORD: PASSWORD,
  }), { host: 'postgres', port: 5432, password: PASSWORD });
  for (const password of ['', 'short', 'A'.repeat(64), `${PASSWORD}\n`]) {
    assert.throws(() => loadLinguaLoopPostgresConfig({
      LINGUALOOP_DB_PASSWORD: password,
    }), LinguaLoopDatabaseConfigurationError);
  }
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

test('transactions run parameterized callback queries on one client and commit before releasing it', async () => {
  const fake = transactionPool();
  const executor = createLinguaLoopQueryExecutor(CONFIG, fake.pool);
  const parameters = ['report-id', "value'; DROP TABLE reports"];
  const result = await executor.withTransaction(async (tx) =>
    tx.query('SELECT $1, $2', parameters));

  assert.deepEqual(result, { rows: [{ value: 1 }] });
  assert.deepEqual(fake.calls, [
    { sql: 'BEGIN', parameters: [] },
    { sql: 'SELECT $1, $2', parameters },
    { sql: 'COMMIT', parameters: [] },
  ]);
  assert.notEqual(fake.calls[1].parameters, parameters);
  assert.equal(fake.releaseCount, 1);
});

test('transactions roll back callback, query, and commit failures and release exactly once', async (t) => {
  for (const scenario of [
    { name: 'callback', run: (tx) => { void tx; throw new Error('callback secret'); } },
    { name: 'query', fail: ['SELECT secret'], run: (tx) => tx.query('SELECT secret', ['secret-value']) },
    { name: 'commit', fail: ['COMMIT'], run: async () => 'done' },
    { name: 'rollback failure', fail: ['SELECT secret', 'ROLLBACK'], run: (tx) => tx.query('SELECT secret', []) },
  ]) {
    await t.test(scenario.name, async () => {
      const fake = transactionPool({ fail: scenario.fail });
      const executor = createLinguaLoopQueryExecutor(CONFIG, fake.pool);
      await assert.rejects(executor.withTransaction(scenario.run), (error) => {
        assert.equal(error.name, 'LinguaLoopDatabaseError');
        assert.equal(error.message, 'LinguaLoop database operation failed.');
        assert.equal(error.message.includes('secret'), false);
        return true;
      });
      assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
      assert.equal(fake.releaseCount, 1);
    });
  }
});

test('caught transaction query failures still roll back and reject without committing', async () => {
  const fake = transactionPool({ fail: ['SELECT sensitive'] });
  const executor = createLinguaLoopQueryExecutor(CONFIG, fake.pool);
  await assert.rejects(executor.withTransaction(async (tx) => {
    try {
      await tx.query('SELECT sensitive', ['private-value']);
    } catch {
      // Deliberately caught: a failed statement still invalidates the transaction.
    }
    return 'must not succeed';
  }), (error) => {
    assert.equal(error.name, 'LinguaLoopDatabaseError');
    assert.equal(error.message, 'LinguaLoop database operation failed.');
    assert.equal(error.message.includes('sensitive'), false);
    assert.equal(error.message.includes('private-value'), false);
    return true;
  });
  assert.deepEqual(fake.calls.map(({ sql }) => sql), ['BEGIN', 'SELECT sensitive', 'ROLLBACK']);
  assert.equal(fake.releaseCount, 1);
});

test('transaction release failures remain generic and release is attempted once', async () => {
  const fake = transactionPool();
  let releaseCount = 0;
  fake.pool.connect = async () => ({
    async query(sql, parameters) { fake.calls.push({ sql, parameters }); return { rows: [] }; },
    release() { releaseCount += 1; throw new Error('release secret'); },
  });
  const executor = createLinguaLoopQueryExecutor(CONFIG, fake.pool);
  await assert.rejects(executor.withTransaction(async () => 'committed'), (error) => {
    assert.equal(error.name, 'LinguaLoopDatabaseError');
    assert.equal(error.message, 'LinguaLoop database operation failed.');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(releaseCount, 1);
});

test('transactions reject unsupported injected pools and closed owned executors', async () => {
  const unsupported = createLinguaLoopQueryExecutor(CONFIG, fakePool().pool);
  await assert.rejects(unsupported.withTransaction(async () => 'unused'), LinguaLoopDatabaseError);

  const closed = createLinguaLoopQueryExecutor(CONFIG);
  await closed.close();
  await assert.rejects(closed.withTransaction(async () => 'unused'), LinguaLoopDatabaseError);
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
