const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openTarget, CONTROL_SQL, MIGRATIONS, REQUIRED_COLUMNS } = require('./helpers/roles-integration-target.cjs');
const enabled = {
  ROLES_INTEGRATION_ENABLE: '1', ROLES_INTEGRATION_ALLOW_WRITES: '1',
  ROLES_INTEGRATION_HOST: '127.0.0.1', ROLES_INTEGRATION_PORT: '5543',
  ROLES_INTEGRATION_DATABASE: 'lingualoop', ROLES_INTEGRATION_USER: 'lingualoop',
  ROLES_INTEGRATION_PASSWORD_FILE: '/fixture/password',
  ROLES_INTEGRATION_SYSTEM_ID: '8000000000000000001', ROLES_INTEGRATION_SERVER_PORT: '5432',
};
function harness(overrides = {}) {
  const calls = [];
  let connections = 0;
  let reads = 0;
  let client;
  const fs = {
    realpathSync: p => p, openSync(_path, flags) {
      assert.equal(flags, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
      return 9;
    }, closeSync() {},
    fstatSync: () => ({ isFile: () => true, size: 64, mode: 0o100600, uid: process.getuid(), nlink: 1 }),
    readSync(_fd, buffer) { reads++; buffer.write('a'.repeat(64)); return 64; },
    ...overrides.fs,
  };
  const makeClient = config => {
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 5543);
    assert.equal(config.database, 'lingualoop'); assert.equal(config.user, 'lingualoop');
    assert.equal(config.password, 'a'.repeat(64));
    assert.equal(config.binary, false); assert.equal(config.client_encoding, 'UTF8');
    assert.equal(config.replication, undefined);
    assert.equal(config.ssl, false); assert.equal(config.options, '-c search_path=public -c statement_timeout=5000 -c lock_timeout=2000');
    client = Object.assign(new EventEmitter(), {
      async connect() { connections++; if (overrides.connect) await overrides.connect(client); },
      async end() { calls.push('END'); if (overrides.end) await overrides.end(); },
      async query(sql) {
        calls.push(sql);
        if (overrides.query) await overrides.query(sql, client);
        if (sql === CONTROL_SQL) return { rows: [{ system_id: enabled.ROLES_INTEGRATION_SYSTEM_ID,
          database: 'lingualoop', username: 'lingualoop', address: '127.0.0.1', server_port: 5432, ...overrides.control }] };
        if (sql.includes('SELECT version, checksum')) return { rows: overrides.ledger ?? MIGRATIONS.map((version, i) => ({ version, checksum: String(i).padStart(64, '0') })) };
        if (sql.includes('information_schema.columns')) return { rows: overrides.columns ?? REQUIRED_COLUMNS.map(([table_name, column_name, data_type]) => ({ table_name, column_name, data_type })) };
        return { rows: [] };
      },
    });
    return client;
  };
  return { calls, fs, makeClient, get client() { return client; }, expectedChecksums: MIGRATIONS.map((_, i) => String(i).padStart(64, '0')),
    get connections() { return connections; }, get reads() { return reads; } };
}
async function denied(env, overrides) {
  const h = harness(overrides);
  await assert.rejects(openTarget(env, h), /Unsafe roles integration target/);
  assert.ok(h.calls.every(sql => sql === CONTROL_SQL || sql === 'END' || sql.startsWith('SELECT')),
    'failed proof never sends a write or transaction');
  return h;
}
test('default disabled integration does not read files, load pg or attempt connection', async () => {
  const h = harness();
  assert.equal(await openTarget({}, h), null);
  const withoutEnable = { ...enabled, PGHOST: 'baseline', PGPORT: '5432', LINGUALOOP_DB_PORT: '5432' };
  delete withoutEnable.ROLES_INTEGRATION_ENABLE;
  assert.equal(await openTarget(withoutEnable, h), null);
  assert.equal(h.connections, 0); assert.equal(h.reads, 0); assert.deepEqual(h.calls, []);
});
test('missing, unknown and unsafe explicit configuration fails before connection', async () => {
  for (const name of Object.keys(enabled).filter(n => !['ROLES_INTEGRATION_ALLOW_WRITES', 'ROLES_INTEGRATION_ENABLE'].includes(n))) {
    const env = { ...enabled }; delete env[name];
    const h = await denied(env); assert.equal(h.connections, 0, name);
  }
  for (const [name, values] of Object.entries({
    ROLES_INTEGRATION_ENABLE: ['true', '0'], ROLES_INTEGRATION_PORT: ['5432', '5000', '5544', '05543'],
    ROLES_INTEGRATION_HOST: ['localhost', 'postgres', '::1'], ROLES_INTEGRATION_DATABASE: ['postgres'],
    ROLES_INTEGRATION_USER: ['postgres'], ROLES_INTEGRATION_PASSWORD_FILE: ['relative/password'],
    ROLES_INTEGRATION_SYSTEM_ID: ['7688892494109220898', '0', '01', '-1', 'abc', '18446744073709551616'],
    ROLES_INTEGRATION_SERVER_PORT: ['5000', 'abc'], ROLES_INTEGRATION_UNKNOWN: ['1'],
  })) for (const value of values) {
    const h = await denied({ ...enabled, [name]: value }); assert.equal(h.connections, 0);
  }
});
test('missing, symlinked, public, wrong-owner and malformed password files fail before connection', async () => {
  for (const fs of [
    { openSync() { throw Error('missing'); } }, { realpathSync: () => '/other/password' },
    { fstatSync: () => ({ isFile: () => true, size: 64, mode: 0o100644, uid: process.getuid(), nlink: 1 }) },
    { fstatSync: () => ({ isFile: () => true, size: 64, mode: 0o100600, uid: process.getuid() + 1, nlink: 1 }) },
    { readSync(_fd, buffer) { buffer.write('z'.repeat(64)); return 64; } },
    { fstatSync: () => ({ isFile: () => false, size: 64, mode: 0o100600, uid: process.getuid(), nlink: 1 }) },
    { fstatSync: () => ({ isFile: () => true, size: 64, mode: 0o100600, uid: process.getuid(), nlink: 2 }) },
    { fstatSync: () => ({ isFile: () => true, size: 1000, mode: 0o100600, uid: process.getuid(), nlink: 1 }) },
  ]) assert.equal((await denied(enabled, { fs })).connections, 0);
});
test('actual TCP proof rejects baseline, mismatched identity, DB, username and server port', async () => {
  for (const control of [{ system_id: '7688892494109220898' }, { system_id: '8000000000000000002' },
    { database: 'postgres' }, { username: 'postgres' }, { address: null }, { server_port: 5000 }]) {
    const h = await denied(enabled, { control }); assert.equal(h.connections, 1);
    assert.deepEqual(h.calls, [CONTROL_SQL, 'END']);
  }
});
test('TCP proof requests PostgreSQL host address and accepts bare private IPv4', async () => {
  const h = harness({ control: { address: '192.168.16.2' } });
  const target = await openTarget(enabled, h);
  try {
    assert.match(h.calls[0], /\bhost\(inet_server_addr\(\)\)\s+AS address\b/);
    assert.doesNotMatch(h.calls[0], /inet_server_addr\(\)::text/);
    assert.equal(target.writeAuthorized, true);
  } finally { await target.close(); }
});
test('TCP proof still rejects masked and malformed addresses before fixture writes', async () => {
  for (const address of ['192.168.16.2/32', '192.168.16.2/24', '192.168.16.999', '192.168.16.2 extra', 'localhost', '::1']) {
    const h = await denied(enabled, { control: { address } });
    assert.deepEqual(h.calls, [CONTROL_SQL, 'END']);
  }
});
test('missing migrations or role/practice snapshot columns reject target before writes', async () => {
  for (const overrides of [{ ledger: [] }, { columns: [] }, { ledger: [{ version: MIGRATIONS[0], checksum: 'f'.repeat(64) }] },
    { columns: REQUIRED_COLUMNS.map(([table_name, column_name]) => ({ table_name, column_name, data_type: 'text' })) }]) {
    await denied(enabled, overrides);
  }
});
test('read-only proof alone never grants fixture writes or transactions', async () => {
  const h = harness(); const env = { ...enabled }; delete env.ROLES_INTEGRATION_ALLOW_WRITES;
  const target = await openTarget(env, h);
  env.ROLES_INTEGRATION_ALLOW_WRITES = '1'; // Mutating caller env cannot elevate a proven read-only capability.
  await assert.rejects(target.query('INSERT INTO anything VALUES (1)', []), /writes not authorized/);
  await assert.rejects(target.withTransaction(async () => {}), /writes not authorized/);
  await target.close();
  assert.ok(h.calls.every(sql => sql === 'END' || sql.startsWith('SELECT')));
});
test('only enabled, identity-proven, schema-checked target can write; closed target cannot', async () => {
  const h = harness(); const target = await openTarget({ ...enabled,
    LINGUALOOP_DB_PASSWORD_FILE: '/never-read/original' }, h);
  await target.query('INSERT INTO fixture VALUES ($1)', ['owned']);
  assert.equal(h.calls.indexOf(CONTROL_SQL), 0);
  assert.ok(h.calls.findIndex(sql => sql.includes('information_schema')) < h.calls.findIndex(sql => sql.startsWith('INSERT')));
  await target.close();
  await assert.rejects(target.query('DELETE FROM fixture', []), /unproved/);
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('write authorization is frozen before deferred connect and proof awaits', async () => {
  for (const stage of ['connect', 'proof']) {
    const entered = deferred(); const resume = deferred();
    const wait = async () => { entered.resolve(); await resume.promise; };
    const h = harness(stage === 'connect' ? { connect: wait } : { query: sql => sql === CONTROL_SQL ? wait() : undefined });
    const env = { ...enabled }; delete env.ROLES_INTEGRATION_ALLOW_WRITES;
    const opening = openTarget(env, h);
    await entered.promise;
    env.ROLES_INTEGRATION_ALLOW_WRITES = '1';
    resume.resolve();
    const target = await opening;
    assert.equal(target.writeAuthorized, false);
    await assert.rejects(target.query('INSERT INTO fixture VALUES (1)', []), /writes not authorized/);
    await target.close();
  }
});
test('in-flight client error is handled before connect and fails proof without unhandled emit', async () => {
  for (const stage of ['connect', 'proof']) {
    let handled = false;
    const disconnect = client => { handled = client.listenerCount('error') > 0; client.emit('error', Error('sensitive synthetic driver detail')); };
    const h = harness(stage === 'connect' ? { connect: disconnect } : { query(sql, client) { if (sql === CONTROL_SQL) disconnect(client); } });
    await assert.rejects(openTarget(enabled, h), /Unsafe roles integration target/);
    assert.equal(handled, true, 'listener installed before any asynchronous work');
    assert.equal(h.calls.filter(s => s === 'END').length, 1);
  }
});
test('post-proof disconnect expires capability and rejects a hanging pending query', async () => {
  const entered = deferred();
  const h = harness({ query(sql) { if (sql.startsWith('INSERT')) { entered.resolve(); return new Promise(() => {}); } } });
  const target = await openTarget(enabled, h);
  const pending = target.query('INSERT INTO fixture VALUES (1)', []);
  await entered.promise;
  assert.doesNotThrow(() => h.client.emit('error', Error('sensitive synthetic driver detail')));
  await assert.rejects(pending, /Roles integration operation failed/);
  await assert.rejects(target.query('SELECT 1', []), /unproved/);
  await assert.rejects(target.withTransaction(async () => {}), /unproved/);
  await assert.rejects(target.close(), /cleanup.*not confirmed/);
  assert.equal(h.calls.filter(s => s === 'END').length, 1);
});
test('rollback and end failures are bounded generic errors with no driver cause', async () => {
  const h = harness({ query(sql) { if (sql === 'ROLLBACK') throw Error('sensitive rollback detail'); },
    end() { throw Error('sensitive end detail'); } });
  const target = await openTarget(enabled, h);
  await assert.rejects(target.withTransaction(async () => { throw Error('sensitive callback detail'); }), error => {
    assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /sensitive/);
    return /cleanup.*not confirmed/.test(error.message);
  });
  await assert.rejects(target.close(), /cleanup.*not confirmed/);
});
test('disconnect during a transaction expires retained ports and never commits', async () => {
  const h = harness(); const target = await openTarget(enabled, h);
  let retained;
  await assert.rejects(target.withTransaction(async tx => {
    retained = tx;
    h.client.emit('error', Error('sensitive disconnect detail'));
    await tx.query('INSERT INTO fixture VALUES (1)', []);
  }), /cleanup.*not confirmed/);
  await assert.rejects(retained.query('SELECT 1', []), /unproved/);
  assert.equal(h.calls.includes('COMMIT'), false);
  assert.ok(!h.calls.some(sql => sql.startsWith('INSERT')));
  await assert.rejects(target.close(), /cleanup.*not confirmed/);
});
test('hanging end is bounded and cannot be reported as successful cleanup', { timeout: 3000 }, async () => {
  const h = harness({ end: () => new Promise(() => {}) });
  const target = await openTarget(enabled, h);
  await assert.rejects(target.close(), error => /cleanup.*not confirmed/.test(error.message) && error.cause === undefined);
  await assert.rejects(target.query('INSERT INTO fixture VALUES (1)', []), /unproved/);
});
test('post-proof query rejection is cause-free and invalidates the target', async () => {
  const h = harness({ query(sql) { if (sql.startsWith('INSERT')) throw Error('sensitive query detail'); } });
  const target = await openTarget(enabled, h);
  await assert.rejects(target.query('INSERT INTO fixture VALUES (1)', []), error => {
    assert.equal(error.cause, undefined); assert.equal(error.message, 'Roles integration operation failed.'); return true;
  });
  await assert.rejects(target.close(), /cleanup.*not confirmed/);
});
test('ordinary PG variables are rejected from supplied and actual environments before construction', async () => {
  for (const name of ['PGHOST', 'PGPORT', 'PGPASSWORD', 'PGBINARY', 'PGCLIENT_ENCODING', 'PGREPLICATION', 'PGSSLMODE', 'NODE_PG_FORCE_NATIVE']) {
    const h = await denied({ ...enabled, [name]: 'synthetic' }); assert.equal(h.connections, 0);
  }
  for (const name of ['PGBINARY', 'PGCLIENT_ENCODING', 'PGREPLICATION']) {
    const previous = process.env[name];
    try {
      process.env[name] = name === 'PGREPLICATION' ? 'database' : name === 'PGCLIENT_ENCODING' ? 'SQL_ASCII' : '1';
      const Parameters = require('pg/lib/connection-parameters'); // Constructs parameters only; no client/socket.
      const parameters = new Parameters({ binary: false, replication: false, client_encoding: '' });
      const field = { PGBINARY: 'binary', PGCLIENT_ENCODING: 'client_encoding', PGREPLICATION: 'replication' }[name];
      assert.equal(parameters[field], process.env[name], 'real pg uses env when explicit config is false/empty');
      assert.equal((await denied(enabled)).connections, 0);
    } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
  }
});
test('proven transactions rollback failures and expire the transaction capability', async () => {
  const h = harness(); const target = await openTarget(enabled, h);
  let retained;
  await assert.rejects(target.withTransaction(async tx => {
    retained = tx;
    await tx.query('INSERT INTO fixture VALUES ($1)', ['owned']);
    throw Error('expected rollback');
  }), /Roles integration operation failed/);
  assert.equal(h.calls.at(-1), 'ROLLBACK');
  assert.equal(h.calls.includes('COMMIT'), false);
  await assert.rejects(retained.query('INSERT INTO fixture VALUES (2)', []), /Transaction ended/);
  await target.withTransaction(async tx => { await tx.query('SELECT 1', []); });
  assert.equal(h.calls.at(-1), 'COMMIT');
  await target.close();
});
