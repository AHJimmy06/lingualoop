const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { openTarget } = require('./helpers/roles-integration-target.cjs');

// Future execution requires separate parent authorization, a new system ID, and schema 001-011.
// Never imports AppModule, a migrator, Docker harness or production bootstrap CLI.
// Test-only identity/code-exchange adapters are private DI values, never headers/env auth bypasses.
test('roles PostgreSQL HTTP integration (explicit fresh-target opt-in only)', {
  skip: process.env.ROLES_INTEGRATION_ENABLE === undefined ? 'explicit integration enable flag absent; no connection attempted' : false,
  timeout: 90000,
}, async t => {
  const environment = process.env; // openTarget snapshots only its approved settings synchronously.
  const target = await openTarget(environment);
  if (!target?.writeAuthorized) {
    if (target) await target.close();
    assert.fail('separate ROLES_INTEGRATION_ALLOW_WRITES=1 required for fixtures');
  }
  const keys = { lingualoop_account_approvals: 'id', lingualoop_accounts: 'id', lingualoop_auth_sessions: 'id',
    lingualoop_practices: 'id', lingualoop_language_practice_sessions: 'id', lingualoop_oauth_states: 'state_hash' };
  const dependents = { lingualoop_language_practice_turns: 'lingualoop_language_practice_sessions',
    lingualoop_language_practice_reports: 'lingualoop_language_practice_sessions',
    lingualoop_language_practice_report_claims: 'lingualoop_language_practice_sessions',
    lingualoop_spent_refresh_hashes: 'lingualoop_auth_sessions' };
  const owned = new Map(Object.keys(keys).map(table => [table, new Set()]));
  let uncertainWrites = false;
  let app;
  // Capture INSERT RETURNING IDs, including writes that precede later assertion failures.
  // Rollback IDs are harmless; no email/prefix/global cleanup predicates are permitted.
  function tracked(executor) {
    return {
      async query(sql, values = []) {
        const table = /INSERT\s+INTO\s+(lingualoop_[a-z_]+)/i.exec(sql)?.[1];
        // OAuthStateDbStore has no RETURNING: its caller-generated hash is the exact primary key.
        if (table === 'lingualoop_oauth_states') {
          assert.match(values[0], /^[0-9a-f]{64}$/);
          owned.get(table).add(values[0]);
        }
        try {
          const result = await executor.query(sql, values);
          if (owned.has(table)) for (const row of result.rows) if (row[keys[table]]) owned.get(table).add(row[keys[table]]);
          return result;
        } catch {
          if (/\b(?:INSERT|UPDATE|DELETE|lingualoop_rotate_refresh)\b/i.test(sql)) uncertainWrites = true;
          throw Error('Fixture database operation failed; write outcome may be unknown.');
        }
      },
      async withTransaction(callback) { return executor.withTransaction(tx => callback(tracked(tx))); },
    };
  }
  const db = tracked(target);
  try {
    // Fresh means empty application business tables, not merely a different cluster identifier.
    for (const [table, key] of Object.entries({ ...keys,
      ...Object.fromEntries(Object.keys(dependents).map(table => [table, 'session_id'])) }))
      assert.equal((await db.query(`SELECT ${key} FROM ${table} LIMIT 1`, [])).rows.length, 0,
        `parent must supply a fresh fixture database: ${table}`);
    require('reflect-metadata');
    const auth = name => require(`../dist/auth/${name}.js`);
    const practice = name => require(`../dist/language-practice/${name}.js`);
    const { Module } = require('@nestjs/common');
    const { NestFactory } = require('@nestjs/core');
    const { JwtService } = require('@nestjs/jwt');
    const { ApprovalStore } = auth('approval-store');
    const { IdentityStore } = auth('identity-store');
    const { SessionStore } = auth('session-store');
    const { RefreshStore } = auth('refresh-store');
    const { LinguaLoopTokenService } = auth('lingualoop-token.service');
    const { GoogleLoginSession } = auth('google-login-session');
    const { RefreshSession } = auth('refresh-session');
    const { GoogleAuthFlow } = auth('google-auth-flow');
    const { OAuthStateService } = auth('oauth-state.service');
    const { OAuthStateDbStore } = auth('oauth-state-db');
    const { createGoogleBrowserPolicy } = auth('google-browser-policy');
    const { ConfiguredVerifiedRequestGuard, GOOGLE_AUTH_FLOW, REFRESH_SESSION } = auth('google-auth.providers');
    const { GoogleAuthController, GOOGLE_AUTH_RATE_LIMITER, GoogleAuthRateLimiter } = auth('google-auth.controller');
    const { GOOGLE_BROWSER_POLICY } = auth('google-browser-policy');
    const stores = auth('auth-store.providers');
    const { AdminAccountsController, CurrentAccountController } = auth('accounts.controller');
    const { RoleGuard } = auth('role.guard');
    const { PracticeCatalogueStore, PRACTICE_CATALOGUE_STORE } = practice('practice-catalogue');
    const { PracticeCatalogueController } = practice('practice-catalogue.controller');
    const { LanguagePracticeSessionStore } = practice('language-practice-session-store');
    const { LanguagePracticeTurnStore } = practice('language-practice-turn-store');
    const { LanguagePracticeTurnService } = practice('language-practice-turn.service');
    const { LanguagePracticeReportStore } = practice('language-practice-report-store');
    const { LanguagePracticeReportService } = practice('language-practice-report.service');
    const { LanguagePracticeSessionController } = practice('language-practice-session.controller');
    const { LanguagePracticeTurnController } = practice('language-practice-turn.controller');
    const { PracticeAudioController } = practice('practice-audio.controller');
    const { PracticeAudioService } = practice('practice-audio.service');
    const { PracticeSynthesisController } = practice('practice-synthesis.controller');
    const { PIPER_RUNTIME } = practice('piper-runtime.providers');
    const sessionPorts = practice('language-practice-session.providers');
    const { LANGUAGE_PRACTICE_TURN_SERVICE } = practice('language-practice-turn.providers');
    const approvals = new ApprovalStore(db);
    const identities = new IdentityStore(db);
    const sessions = new SessionStore(db);
    const refresh = new RefreshStore(db);
    const signing = new LinguaLoopTokenService(new JwtService(), randomBytes(32));
    const run = randomUUID();
    const names = ['admin', 'teacher1', 'teacher2', 'student1', 'student2'];
    const emails = names.map(name => `${name}+${run}@example.test`);
    const subjects = new Map(emails.map(email => [email, `${run}:${email}`]));
    const login = new GoogleLoginSession({ identityStore: identities, sessionStore: sessions, refreshStore: refresh,
      tokenService: signing, googleIdentityService: { async verify(email) {
        assert.ok(email.endsWith('@example.test'));
        return { issuer: 'google', subject: subjects.get(email) ?? `${run}:${email}`, email };
      } } });
    const refreshSession = new RefreshSession({ refreshStore: refresh, sessionStore: sessions, tokenService: signing });
    // Production hash-only DB contract needs no OAuth secret; only external exchange/verification are fakes.
    const states = new OAuthStateDbStore(db);
    const stateService = new OAuthStateService(states);
    const origin = 'http://localhost:5101';
    const policy = createGoogleBrowserPolicy({ callbackUrl: 'http://localhost:5100/auth/google/callback', webOrigin: origin });
    const flow = new GoogleAuthFlow({ callbackUrl: 'http://localhost:5100/auth/google/callback', webOrigin: origin,
      clientId: 'roles-test.apps.googleusercontent.com', stateService, loginSession: login,
      codeExchange: { async exchange(code) { return { idToken: code }; } } });
    const practiceSessions = new LanguagePracticeSessionStore(db);
    const turns = new LanguagePracticeTurnStore(db);
    const reports = new LanguagePracticeReportStore(db);
    let providerCalls = 0;
    let reportCalls = 0;
    let invalidEvidence = false;
    const turnService = new LanguagePracticeTurnService({ turnStore: turns, history: turns,
      sessions: { getOwnedSession: (owner, id) => practiceSessions.getOwnedSnapshot(owner, id) },
      speechToText: { async transcribeBounded() { providerCalls++; return 'I want to visit France.'; } },
      synthesis: { async synthesizeLocal() { return Buffer.from('test-only-wav'); } },
      coach: { async respond(input) {
        assert.equal(input.parameters[0].requirement, 'Explain your destination');
        return { assistantResponse: 'Why France?', correctedPhrase: 'I want to visit France.', feedback: 'Buena frase.' };
      } }, diagnostics: { report() {} } });
    const reportService = new LanguagePracticeReportService(reports, { async generate(evidence, options) {
      reportCalls++;
      return { summary: 'Práctica de viaje.', corrections: [], strengths: ['Frase clara.'], recommendations: [],
        parameterCoverage: options.parameters.map(p => ({ parameterId: p.id, requirement: p.requirement,
          status: 'met', evidenceSequences: [invalidEvidence ? 2 : evidence[0].sequence], explanation: 'Describió el destino.' })) };
    } }, { report() {} });
    class PrivateRolesIntegrationModule {}
    Module({ controllers: [GoogleAuthController, CurrentAccountController, AdminAccountsController,
      PracticeCatalogueController, LanguagePracticeSessionController, LanguagePracticeTurnController,
      PracticeAudioController, PracticeSynthesisController], providers: [
      ConfiguredVerifiedRequestGuard, RoleGuard,
      { provide: GOOGLE_AUTH_FLOW, useValue: flow }, { provide: REFRESH_SESSION, useValue: refreshSession },
      { provide: GOOGLE_AUTH_RATE_LIMITER, useValue: new GoogleAuthRateLimiter() },
      { provide: GOOGLE_BROWSER_POLICY, useValue: policy }, { provide: LinguaLoopTokenService, useValue: signing },
      { provide: stores.LINGUALOOP_APPROVAL_STORE, useValue: approvals },
      { provide: stores.LINGUALOOP_IDENTITY_STORE, useValue: identities },
      { provide: stores.LINGUALOOP_SESSION_STORE, useValue: sessions },
      { provide: stores.LINGUALOOP_OAUTH_STATE_STORE, useValue: states },
      { provide: stores.LINGUALOOP_REFRESH_STORE, useValue: refresh },
      { provide: OAuthStateService, useValue: stateService },
      { provide: PRACTICE_CATALOGUE_STORE, useValue: new PracticeCatalogueStore(db) },
      { provide: sessionPorts.LANGUAGE_PRACTICE_SESSION_STORE, useValue: practiceSessions },
      { provide: sessionPorts.LANGUAGE_PRACTICE_TURN_STORE, useValue: turns },
      { provide: sessionPorts.LANGUAGE_PRACTICE_REPORT_SERVICE, useValue: reportService },
      { provide: LANGUAGE_PRACTICE_TURN_SERVICE, useValue: turnService },
      { provide: PracticeAudioService, useValue: { async transcribe() { return 'Mocked transcription.'; } } },
      { provide: PIPER_RUNTIME, useValue: { getHost() { return { async synthesize() { return Buffer.from('test-only-wav'); } }; } } },
    ] })(PrivateRolesIntegrationModule);
    app = await NestFactory.create(PrivateRolesIntegrationModule, { logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function request(path, token, method = 'GET', body, extra = {}) {
      const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      return { status: response.status, body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
        cookies: response.headers.getSetCookie() };
    }
    async function browserLogin(email, expected = 302) {
      const start = await fetch(base + '/auth/google', { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      assert.equal(start.status, 302);
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const hash = createHash('sha256').update(state).digest('hex');
      assert.equal((await db.query('SELECT state_hash FROM lingualoop_oauth_states WHERE state_hash=$1', [hash])).rows.length, 1);
      const result = await request(`/auth/google/callback?code=${encodeURIComponent(email)}&state=${state}`, null, 'GET', undefined,
        { cookie: start.headers.getSetCookie()[0].split(';')[0] });
      assert.equal(result.status, expected);
      assert.equal((await db.query('SELECT state_hash FROM lingualoop_oauth_states WHERE state_hash=$1', [hash])).rows.length, 0);
      assert.equal((await request(`/auth/google/callback?code=${encodeURIComponent(email)}&state=${state}`, null, 'GET', undefined,
        { cookie: start.headers.getSetCookie()[0].split(';')[0] })).status, 400, 'real persisted state is single-use');
      if (expected !== 302) return;
      const cookie = result.cookies.find(c => c.startsWith('lingualoop-refresh=')).split(';')[0];
      const rotated = await request('/auth/refresh', null, 'POST', undefined, { origin, cookie });
      assert.equal(rotated.status, 200);
      assert.deepEqual(Object.keys(rotated.body), ['accessToken']);
      return { token: rotated.body.accessToken, cookie: rotated.cookies[0].split(';')[0] };
    }
    await t.test('unapproved verified Google email creates no account or auth session', async () => {
      await browserLogin(`unapproved+${run}@example.test`, 400);
      assert.equal((await db.query('SELECT id FROM lingualoop_accounts', [])).rows.length, 0);
      assert.equal((await db.query('SELECT id FROM lingualoop_auth_sessions', [])).rows.length, 0);
    });
    await approvals.bootstrapFirstAdmin(emails[0]); // Explicit fixture method, never a CLI/startup hook.
    const admin = await browserLogin(emails[0]);
    const actors = { admin };
    await t.test('admin public approval DTO, duplicate and forbidden role contract', async () => {
      for (const email of emails.slice(1)) {
        const role = email.startsWith('teacher') ? 'teacher' : 'student';
        const created = await request('/admin/accounts', admin.token, 'POST', { email, role });
        assert.equal(created.status, 201);
        assert.deepEqual(Object.keys(created.body).sort(), ['createdAt', 'email', 'id', 'linked', 'role']);
        assert.equal(created.body.linked, false);
        assert.equal((await request('/admin/accounts', admin.token, 'POST', { email, role })).status, 409);
        actors[email.split('+')[0]] = await browserLogin(email);
      }
      for (const role of ['admin', 'owner', 'Teacher']) assert.equal((await request('/admin/accounts', admin.token,
        'POST', { email: `forbidden-${run}@example.test`, role })).status, 400);
      assert.equal((await request('/admin/accounts', admin.token, 'POST',
        { email: `extra-${run}@example.test`, role: 'student', ownerId: randomUUID() })).status, 400);
      const listed = await request('/admin/accounts', admin.token);
      assert.equal(listed.status, 200);
      assert.deepEqual(new Set(listed.body.accounts.map(a => a.email)), new Set(emails));
      assert.ok(listed.body.accounts.every(a => a.linked));
      for (const [name, actor] of Object.entries(actors)) {
        const me = await request('/auth/me', actor.token);
        assert.equal(me.status, 200);
        assert.deepEqual(Object.keys(me.body).sort(), ['email', 'ownerId', 'role']);
        actor.owner = me.body.ownerId;
        if (name !== 'admin') assert.equal((await request('/admin/accounts', actor.token)).status, 403);
      }
    });
    const setup = { topic: 'travel', level: 'B1', durationMinutes: 5 };
    const practiceInput = { title: `Destination ${run}`, setup, parameters: [{ requirement: 'Explain your destination' }] };
    let first;
    let custom;
    let defaultSession;
    await t.test('teacher ownership, global student catalogue and authoritative custom snapshot', async () => {
      for (const path of ['/auth/me', '/admin/accounts', '/language-practice/options', '/language-practice/practices'])
        assert.equal((await request(path, null)).status, 401);
      assert.equal((await request('/language-practice/practices', actors.teacher1.token, 'POST',
        { ...practiceInput, teacherId: actors.teacher2.owner })).status, 400);
      const created = await request('/language-practice/practices', actors.teacher1.token, 'POST', practiceInput);
      assert.equal(created.status, 201); first = created.body;
      assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'id', 'parameters', 'setup', 'teacherId', 'title']);
      assert.equal(first.teacherId, actors.teacher1.owner);
      const other = await request('/language-practice/practices', actors.teacher2.token, 'POST', { ...practiceInput, title: `Other ${run}` });
      assert.equal(other.status, 201);
      assert.deepEqual((await request('/language-practice/practices', actors.teacher1.token)).body, { practices: [first] });
      assert.equal((await request(`/language-practice/practices/${first.id}`, actors.teacher2.token)).status, 404);
      assert.equal((await request('/language-practice/practices', admin.token)).status, 403);
      assert.equal((await request(`/language-practice/practices/${first.id}`, admin.token)).status, 403);
      const catalogue = (await request('/language-practice/practices', actors.student1.token)).body.practices;
      assert.deepEqual(new Set(catalogue.map(p => p.id)), new Set([first.id, other.body.id]));
      for (const body of [{ practiceId: first.id, ...setup }, { practiceId: first.id, parameters: [] }, { ...setup, extra: true }])
        assert.equal((await request('/language-practice/sessions', actors.student1.token, 'POST', body)).status, 400);
      const response = await request('/language-practice/sessions', actors.student1.token, 'POST', { practiceId: first.id });
      assert.equal(response.status, 201); custom = response.body;
      assert.deepEqual(Object.keys(custom).sort(), ['durationMinutes', 'expiresAt', 'id', 'level', 'remainingMs', 'startedAt', 'status', 'topic', 'turnInProgress', 'turns']);
      assert.equal(custom.level, setup.level); assert.equal(custom.topic, setup.topic);
      assert.equal(custom.durationMinutes, setup.durationMinutes);
      const snapshot = (await db.query('SELECT practice_id, parameters_snapshot FROM lingualoop_language_practice_sessions WHERE id=$1', [custom.id])).rows[0];
      assert.equal(snapshot.practice_id, first.id); assert.deepEqual(snapshot.parameters_snapshot, first.parameters);
      await db.query('UPDATE lingualoop_practices SET topic=$2, parameters=$3::jsonb WHERE id=$1',
        [first.id, 'work', JSON.stringify([{ ...first.parameters[0], requirement: 'Changed catalogue later' }])]);
      assert.deepEqual(await practiceSessions.getOwnedSnapshot(actors.student1.owner, custom.id),
        { level: 'B1', topic: 'travel', parameters: first.parameters });
      const defaultResponse = await request('/language-practice/sessions', actors.student1.token, 'POST', setup);
      assert.equal(defaultResponse.status, 201); defaultSession = defaultResponse.body;
      assert.deepEqual((await practiceSessions.getOwnedSnapshot(actors.student1.owner, defaultSession.id)).parameters, []);
      for (const suffix of ['', '/finish', '/report']) assert.equal((await request(`/language-practice/sessions/${custom.id}${suffix}`,
        actors.student2.token, suffix ? 'POST' : 'GET')).status, 404);
      for (const actor of [admin, actors.teacher1]) {
        for (const [path, method, body] of [['/language-practice/options', 'GET'], ['/language-practice/sessions', 'POST', setup],
          [`/language-practice/sessions/${custom.id}`, 'GET'], [`/language-practice/sessions/${custom.id}/finish`, 'POST'],
          [`/language-practice/sessions/${custom.id}/report`, 'POST'], [`/language-practice/sessions/${custom.id}/turns`, 'POST'],
          ['/practice/transcribe', 'POST'], ['/practice/synthesize', 'POST', { text: 'Hello', language: 'en' }]])
          assert.equal((await request(path, actor.token, method, body)).status, 403);
      }
      for (const actor of [admin, actors.student1]) assert.equal((await request('/language-practice/practices', actor.token, 'POST', practiceInput)).status, 403);
    });
    await t.test('real turn persistence, foreign evidence rejection, ordered coverage and cached report', async () => {
      async function sendTurn(actor, id, clientTurnId) {
        const form = new FormData(); form.set('clientTurnId', clientTurnId);
        form.set('audio', new Blob([Buffer.from('test-audio')], { type: 'audio/wav' }), 'fixture.wav');
        const response = await fetch(`${base}/language-practice/sessions/${id}/turns`, { method: 'POST',
          headers: { authorization: `Bearer ${actor.token}` }, body: form, signal: AbortSignal.timeout(8000) });
        return { status: response.status, body: await response.json() };
      }
      assert.equal((await sendTurn(actors.student2, custom.id, randomUUID())).status, 404);
      assert.equal(providerCalls, 0);
      const clientTurnId = randomUUID();
      const turn = await sendTurn(actors.student1, custom.id, clientTurnId);
      assert.equal(turn.status, 201); assert.equal(turn.body.sequence, 1);
      assert.equal(turn.body.transcript, 'I want to visit France.');
      assert.equal((await sendTurn(actors.student1, custom.id, clientTurnId)).status, 201);
      assert.equal(providerCalls, 1, 'idempotent replay never reinfers');
      // Another session has real sequence 2: that number is not valid evidence for custom session.
      const foreign = await practiceSessions.createCustomSession(actors.student2.owner, first.id);
      await turns.reserveTurn(actors.student2.owner, foreign.id, randomUUID()).then(async ({ turn: reserved }) => {
        await turns.completeTurn(actors.student2.owner, foreign.id, reserved.id, reserved.leaseToken, 'Foreign first', 'Reply', '{}');
      });
      await turns.reserveTurn(actors.student2.owner, foreign.id, randomUUID()).then(async ({ turn: reserved }) => {
        await turns.completeTurn(actors.student2.owner, foreign.id, reserved.id, reserved.leaseToken, 'Foreign second', 'Reply', '{}');
      });
      assert.equal((await request(`/language-practice/sessions/${custom.id}/finish`, actors.student1.token, 'POST')).status, 200);
      invalidEvidence = true;
      assert.equal((await request(`/language-practice/sessions/${custom.id}/report`, actors.student1.token, 'POST')).status, 503);
      assert.equal((await db.query('SELECT session_id FROM lingualoop_language_practice_reports WHERE session_id=$1', [custom.id])).rows.length, 0);
      invalidEvidence = false;
      const report = await request(`/language-practice/sessions/${custom.id}/report`, actors.student1.token, 'POST');
      assert.equal(report.status, 200);
      assert.deepEqual(report.body.parameterCoverage, [{ parameterId: first.parameters[0].id, requirement: first.parameters[0].requirement,
        status: 'met', evidenceSequences: [1], explanation: 'Describió el destino.' }]);
      assert.deepEqual(Object.keys(report.body).sort(), ['corrections', 'createdAt', 'generatedWithAi', 'parameterCoverage', 'recommendations', 'sessionId', 'strengths', 'summary']);
      assert.deepEqual((await request(`/language-practice/sessions/${custom.id}/report`, actors.student1.token, 'POST')).body, report.body);
      assert.equal(reportCalls, 2, 'failed evidence + successful generation, cached read does not regenerate');
      await request(`/language-practice/sessions/${defaultSession.id}/finish`, actors.student1.token, 'POST');
      assert.deepEqual((await request(`/language-practice/sessions/${defaultSession.id}/report`, actors.student1.token, 'POST')).body.parameterCoverage, []);
    });
    await t.test('wrong Origin never rotates/revokes; real logout invalidates bearer session', async () => {
      const actor = actors.student2;
      for (const route of ['/auth/refresh', '/auth/logout']) assert.equal((await request(route, actor.token, 'POST', undefined,
        { origin: 'http://localhost:5001', cookie: actor.cookie })).status, 403);
      assert.equal((await request('/auth/me', actor.token)).status, 200);
      assert.equal((await request('/auth/logout', actor.token, 'POST', undefined, { origin, cookie: actor.cookie })).status, 204);
      assert.equal((await request('/auth/me', actor.token)).status, 401);
    });
    await t.test('abandoned persisted OAuth state remains owned for exact-key finally cleanup', async () => {
      const start = await fetch(base + '/auth/google', { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      assert.equal(start.status, 302);
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const hash = createHash('sha256').update(state).digest('hex');
      assert.ok(owned.get('lingualoop_oauth_states').has(hash));
      assert.equal((await db.query('SELECT state_hash FROM lingualoop_oauth_states WHERE state_hash=$1', [hash])).rows.length, 1);
    });
    await t.test('independent PostgreSQL clients block on approval lock and bind exactly one subject', async () => {
      const approval = await approvals.create(`race-${run}@example.test`, 'student');
      const a = await openTarget(environment);
      let b;
      try {
        b = await openTarget(environment);
        const clientA = tracked(a); const clientB = tracked(b);
        const pidA = (await clientA.query('SELECT pg_backend_pid() AS pid', [])).rows[0].pid;
        const pidB = (await clientB.query('SELECT pg_backend_pid() AS pid', [])).rows[0].pid;
        assert.notEqual(pidA, pidB);
        let unlock;
        let signalLocked;
        const locked = new Promise(resolve => { signalLocked = resolve; });
        const hold = new Promise(resolve => { unlock = resolve; });
        const firstBinding = clientA.withTransaction(async tx => {
          await tx.query('SELECT id FROM lingualoop_account_approvals WHERE id=$1 FOR UPDATE', [approval.id]);
          signalLocked();
          await Promise.race([hold, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('lock hold timeout')), 1000); timer.unref(); })]);
          // Nested store transaction delegates to this existing, real client A transaction.
          return new IdentityStore({ query: tx.query, withTransaction: callback => callback(tx) }).getOrCreateOwner({
            issuer: 'google', subject: `${run}:race-a`, email: approval.email });
        }).then(value => ({ value }), error => ({ error }));
        await Promise.race([locked, firstBinding.then(() => { throw Error('first client failed before lock acquisition'); })]);
        let secondSettled = false;
        const secondBinding = new IdentityStore(clientB).getOrCreateOwner({ issuer: 'google', subject: `${run}:race-b`, email: approval.email })
          .then(value => ({ value }), error => ({ error })).finally(() => { secondSettled = true; });
        let firstResult;
        let secondResult;
        try {
          const deadline = Date.now() + 700;
          let observedLock = false;
          while (Date.now() < deadline && !observedLock) {
            observedLock = (await db.query("SELECT pid FROM pg_stat_activity WHERE pid=$1 AND application_name='roles-test-only' AND wait_event_type='Lock' AND query LIKE '%lingualoop_account_approvals%'", [pidB])).rows.length === 1;
            if (!observedLock) await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.equal(observedLock, true, 'observe actual PostgreSQL lock wait, not merely scheduling delay');
          assert.equal(secondSettled, false);
        } finally {
          unlock();
          [firstResult, secondResult] = await Promise.all([firstBinding, secondBinding]);
        }
        assert.equal(firstResult.error, undefined);
        const owner = firstResult.value;
        assert.ok(secondResult.error, 'second distinct subject cannot steal approval');
        assert.equal((await db.query('SELECT account_id FROM lingualoop_account_approvals WHERE id=$1', [approval.id])).rows[0].account_id, owner);
        assert.equal((await db.query('SELECT id FROM lingualoop_accounts WHERE subject=$1', [`${run}:race-b`])).rows.length, 0);
      } finally { try { await a.close(); } finally { if (b) await b.close(); } }
    });
  } finally {
    try {
      if (app) await app.close();
    } finally {
      try {
        // FK dependents (turns/reports/claims/spent hashes) cascade only from these exact owned IDs.
        await target.withTransaction(async tx => {
          for (const table of ['lingualoop_language_practice_sessions', 'lingualoop_practices',
            'lingualoop_auth_sessions', 'lingualoop_account_approvals', 'lingualoop_accounts', 'lingualoop_oauth_states']) {
            const ids = [...owned.get(table)];
            const type = keys[table] === 'state_hash' ? 'text' : 'uuid';
            if (ids.length) await tx.query(`DELETE FROM ${table} WHERE ${keys[table]}=ANY($1::${type}[])`, [ids]);
          }
        });
        for (const [table, key] of Object.entries(keys)) {
          const ids = [...owned.get(table)];
          const type = key === 'state_hash' ? 'text' : 'uuid';
          if (ids.length) assert.equal((await target.query(`SELECT ${key} FROM ${table} WHERE ${key}=ANY($1::${type}[])`, [ids])).rows.length,
            0, 'exact owned primary keys must be absent after committed cleanup');
        }
        for (const [table, parent] of Object.entries(dependents)) {
          const ids = [...owned.get(parent)];
          if (ids.length) assert.equal((await target.query(`SELECT session_id FROM ${table} WHERE session_id=ANY($1::uuid[])`, [ids])).rows.length,
            0, 'exact owned session dependents must be absent');
        }
        assert.equal(uncertainWrites, false, 'unknown write outcome: cleanup cannot be guaranteed; fresh fixture cluster required');
      } finally { await target.close(); }
    }
  }
});
