const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const BASELINE = '7688892494109220898';
const MIGRATIONS = [
  '001_owner_identity.sql', '002_oauth_state.sql', '003_auth_sessions.sql',
  '004_refresh_rotation.sql', '005_language_practice_sessions.sql', '006_language_practice_turns.sql',
  '007_language_practice_turn_lease.sql', '008_language_practice_reports.sql',
  '009_language_practice_ai_reports.sql', '010_language_practice_report_claims.sql', '011_roles_practices.sql',
];
const REQUIRED_COLUMNS = [
  ['lingualoop_account_approvals', 'role', 'character varying'],
  ['lingualoop_account_approvals', 'account_id', 'uuid'],
  ['lingualoop_practices', 'teacher_id', 'uuid'], ['lingualoop_practices', 'parameters', 'jsonb'],
  ['lingualoop_language_practice_sessions', 'practice_id', 'uuid'],
  ['lingualoop_language_practice_sessions', 'parameters_snapshot', 'jsonb'],
  ['lingualoop_language_practice_reports', 'parameter_coverage', 'jsonb'],
];
const CONTROL_SQL = `SELECT system_identifier::text AS system_id, current_database() AS database,
  current_user AS username, host(inet_server_addr()) AS address, inet_server_port() AS server_port
  FROM pg_control_system()`;
const NAMES = ['ENABLE', 'ALLOW_WRITES', 'HOST', 'PORT', 'DATABASE', 'USER',
  'PASSWORD_FILE', 'SYSTEM_ID', 'SERVER_PORT'].map(s => `ROLES_INTEGRATION_${s}`);
const unsafe = () => new Error('Unsafe roles integration target; no fixture writes permitted.');
function configFrom(env, io) {
  if (Object.keys(env).some(k => k.startsWith('ROLES_INTEGRATION_') && !NAMES.includes(k)) ||
      env.ROLES_INTEGRATION_ENABLE !== '1' ||
      ![undefined, '1'].includes(env.ROLES_INTEGRATION_ALLOW_WRITES) ||
      env.ROLES_INTEGRATION_HOST !== '127.0.0.1' || env.ROLES_INTEGRATION_PORT !== '5543' ||
      env.ROLES_INTEGRATION_DATABASE !== 'lingualoop' || env.ROLES_INTEGRATION_USER !== 'lingualoop' ||
      !['5432', '5543'].includes(env.ROLES_INTEGRATION_SERVER_PORT)) throw unsafe();
  const id = env.ROLES_INTEGRATION_SYSTEM_ID;
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id) ||
      BigInt(id) > 18446744073709551615n || id === BASELINE) throw unsafe();
  const filename = env.ROLES_INTEGRATION_PASSWORD_FILE;
  if (typeof filename !== 'string' || !path.isAbsolute(filename) ||
      path.normalize(filename) !== filename || io.realpathSync(filename) !== filename) throw unsafe();
  let fd;
  let password;
  try {
    fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || ![64, 65].includes(stat.size) || (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid() || stat.nlink !== 1) throw unsafe();
    const buffer = Buffer.alloc(66);
    const size = io.readSync(fd, buffer, 0, buffer.length, 0);
    password = buffer.subarray(0, size).toString('utf8');
    if (size !== stat.size || !/^[0-9a-f]{64}\n?$/.test(password)) throw unsafe();
    password = password.trimEnd();
  } finally { if (fd !== undefined) io.closeSync(fd); }
  // Critical target fields are explicit. Unset ordinary PG variables are a separate entry gate.
  return { host: '127.0.0.1', port: 5543, database: 'lingualoop', user: 'lingualoop', password,
    ssl: false, binary: false, client_encoding: 'UTF8', replication: undefined,
    application_name: 'roles-test-only', connectionTimeoutMillis: 3000,
    query_timeout: 6000, statement_timeout: 5000, lock_timeout: 2000,
    options: '-c search_path=public -c statement_timeout=5000 -c lock_timeout=2000' };
}
async function openTarget(env = {}, dependencies = {}) {
  // Freeze validated intent synchronously: caller mutation during any await cannot upgrade it.
  const suppliedKeys = Object.keys(env);
  env = Object.freeze(Object.fromEntries(NAMES.map(name => [name, env[name]])));
  if (env.ROLES_INTEGRATION_ENABLE === undefined) return null;
  const writeAuthorized = env.ROLES_INTEGRATION_ALLOW_WRITES === '1';
  let client;
  let failed = false;
  let closed = false;
  let cleanupFailed = false;
  let ending;
  let signalDisconnect;
  const disconnected = new Promise(resolve => { signalDisconnect = resolve; });
  const operationError = () => new Error('Roles integration operation failed.');
  const cleanupError = () => new Error('Roles integration cleanup is not confirmed; fresh fixture cluster required.');
  async function bounded(work, milliseconds, watchDisconnect = false) {
    let timer;
    try {
      const racers = [Promise.resolve().then(work), new Promise((_, reject) => {
        timer = setTimeout(() => reject(operationError()), milliseconds);
      })];
      if (watchDisconnect) racers.push(disconnected.then(() => { throw operationError(); }));
      return await Promise.race(racers);
    } finally { clearTimeout(timer); }
  }
  function endClient() {
    ending ??= bounded(() => client.end(), 1000).catch(() => { cleanupFailed = true; });
    return ending;
  }
  function invalidate() {
    failed = true;
    signalDisconnect();
    void endClient(); // Its rejection is consumed and recorded, not reported as cleanup success.
  }
  async function operate(work) {
    if (failed || closed) throw operationError();
    try {
      const value = await bounded(() => {
        if (failed || closed) throw operationError();
        return work();
      }, 6000, true);
      if (failed || closed) throw operationError();
      return value;
    } catch { invalidate(); throw operationError(); }
  }
  try {
    // pg uses truthiness fallbacks for binary/encoding/replication. Never mutate process.env.
    // Reject presence (even empty strings) in both snapshots before creating any client.
    if (suppliedKeys.some(k => k.startsWith('ROLES_INTEGRATION_') && !NAMES.includes(k))) throw unsafe();
    for (const keys of [suppliedKeys, Object.keys(process.env)]) if (keys.some(k =>
      k.startsWith('PG') || k === 'NODE_PG_FORCE_NATIVE')) throw unsafe();
    const config = configFrom(env, dependencies.fs ?? fs);
    const makeClient = dependencies.makeClient ?? (c => new (require('pg').Client)(c));
    client = makeClient(config);
    client.on('error', invalidate); // Installed before connect; retained after close for late error events.
    await operate(() => client.connect());
    const proof = (await operate(() => client.query(CONTROL_SQL, []))).rows;
    if (proof.length !== 1 || proof[0].system_id !== env.ROLES_INTEGRATION_SYSTEM_ID ||
        proof[0].system_id === BASELINE || proof[0].database !== 'lingualoop' ||
        proof[0].username !== 'lingualoop' || require('node:net').isIP(proof[0].address) !== 4 ||
        proof[0].server_port !== Number(env.ROLES_INTEGRATION_SERVER_PORT)) throw unsafe();
    const checksums = dependencies.expectedChecksums ?? MIGRATIONS.map(name =>
      createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../db/migrations', name))).digest('hex'));
    const ledger = (await operate(() => client.query('SELECT version, checksum FROM public.lingualoop_schema_migrations ORDER BY version', []))).rows;
    if (ledger.length !== MIGRATIONS.length || checksums.length !== MIGRATIONS.length ||
        ledger.some((row, i) => row.version !== MIGRATIONS[i] || row.checksum !== checksums[i])) throw unsafe();
    const columns = (await operate(() => client.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...new Set(REQUIRED_COLUMNS.map(c => c[0]))]]))).rows;
    if (!REQUIRED_COLUMNS.every(([table, column, type]) => columns.some(c =>
      c.table_name === table && c.column_name === column && c.data_type === type))) throw unsafe();
    let inTransaction = false;
    function authorize() {
      if (closed || failed) throw Error('Roles integration target unproved or closed.');
      if (!writeAuthorized) throw Error('Roles integration fixture writes not authorized.');
    }
    return {
      writeAuthorized,
      async query(sql, parameters = []) { authorize(); return operate(() => client.query(sql, parameters)); },
      async withTransaction(callback) {
        authorize();
        if (inTransaction) throw Error('Use independent proven clients for concurrency.');
        inTransaction = true;
        let active = false;
        try {
          await operate(() => client.query('BEGIN', [])); active = true;
          const result = await bounded(() => callback({ async query(sql, parameters = []) {
            authorize(); if (!active) throw Error('Transaction ended.');
            return operate(() => client.query(sql, parameters));
          } }), 6000, true);
          await operate(() => client.query('COMMIT', [])); active = false; return result;
        } catch {
          active = false;
          if (!failed) {
            try { await bounded(() => client.query('ROLLBACK', []), 1000); }
            catch { cleanupFailed = true; invalidate(); }
          }
          if (failed || cleanupFailed) { await endClient(); throw cleanupError(); }
          throw operationError();
        } finally { active = false; inTransaction = false; }
      },
      async close() {
        closed = true;
        await endClient();
        if (failed || cleanupFailed) throw cleanupError();
      },
    };
  } catch {
    closed = true;
    if (client) await endClient();
    if (cleanupFailed) throw new Error('Unsafe roles integration target; cleanup is not confirmed.');
    throw unsafe();
  }
}
module.exports = { openTarget, CONTROL_SQL, MIGRATIONS, REQUIRED_COLUMNS };
