const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfiguredVerifiedRequestGuard } = require('../dist/auth/google-auth.providers.js');
const { RoleGuard } = require('../dist/auth/role.guard.js');
const { GOOGLE_BROWSER_POLICY, createGoogleBrowserPolicy } = require('../dist/auth/google-browser-policy.js');
const origin = 'http://127.0.0.1:3000';
const { LinguaLoopTokenService } = require('../dist/auth/lingualoop-token.service.js');
const { InvalidBearerTokenError } = require('../dist/auth/verified-request.guard.js');
const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../dist/auth/auth-store.providers.js');
const { PracticeCatalogueStore, PRACTICE_CATALOGUE_STORE } = require('../dist/language-practice/practice-catalogue.js');
const { PracticeCatalogueController } = require('../dist/language-practice/practice-catalogue.controller.js');
const { LanguagePracticeSessionController } = require('../dist/language-practice/language-practice-session.controller.js');
const { LanguagePracticeTurnController } = require('../dist/language-practice/language-practice-turn.controller.js');
const { PracticeAudioController } = require('../dist/language-practice/practice-audio.controller.js');
const { PracticeSynthesisController } = require('../dist/language-practice/practice-synthesis.controller.js');
const { LANGUAGE_PRACTICE_SESSION_STORE, LANGUAGE_PRACTICE_TURN_STORE, LANGUAGE_PRACTICE_REPORT_SERVICE, LANGUAGE_PRACTICE_REPORT_STORE } = require('../dist/language-practice/language-practice-session.providers.js');
const { LANGUAGE_PRACTICE_TURN_SERVICE } = require('../dist/language-practice/language-practice-turn.providers.js');
const { PracticeAudioService } = require('../dist/language-practice/practice-audio.service.js');
const { PIPER_RUNTIME } = require('../dist/language-practice/piper-runtime.providers.js');
const A = '123e4567-e89b-42d3-a456-426614174000';
const B = '123e4567-e89b-42d3-a456-426614174001';
const S = '223e4567-e89b-42d3-a456-426614174000';
const P = '323e4567-e89b-42d3-a456-426614174000';
const Q = '323e4567-e89b-42d3-a456-426614174001';
const setup = { topic: 'travel', level: 'B1', durationMinutes: 5 };
const input = { title: 'Plan a trip', setup: { level: setup.level, durationMinutes: setup.durationMinutes }, parameters: [{ requirement: 'Explain your destination' }] };

test('HTTP role matrix, global student catalogue, teacher isolation and exact custom request contract', async t => {
  let role = 'teacher';
  let ownerId = A;
  let dependencyFailure = false;
  const rows = [];
  const calls = [];
  const catalogue = new PracticeCatalogueStore({ async query(sql, values) {
    if (dependencyFailure) throw Error('PRIVATE DB');
    if (sql.includes('INSERT')) {
      const row = { id: rows.length ? Q : P, teacher_id: values[0], teacher_name: values[0] === A ? 'Teacher A' : 'Teacher B', title: values[1], topic: values[2], level: values[3], duration_minutes: values[4], parameters: JSON.parse(values[5]), difficulty: values[7], activity: JSON.parse(values[8]), created_at: new Date('2026-01-01') };
      rows.push(row); return { rows: [row] };
    }
    assert.ok(sql.includes('ORDER BY p.created_at ASC, p.id ASC') || sql.includes('WHERE p.id = $1::uuid'));
    return { rows: rows.filter(row => sql.includes('WHERE p.id') ? row.id === values[0] && (!sql.includes('AND p.teacher_id') || row.teacher_id === values[1]) : !sql.includes('WHERE p.teacher_id') || row.teacher_id === values[0]) };
  } });
  const session = { id: S, status: 'ACTIVE', ...setup, startedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z', remainingMs: 300000, turnInProgress: false };
  class OfflineModule {}
  Module({ controllers: [PracticeCatalogueController, LanguagePracticeSessionController, LanguagePracticeTurnController, PracticeAudioController, PracticeSynthesisController], providers: [
    ConfiguredVerifiedRequestGuard, RoleGuard,
    { provide: GOOGLE_BROWSER_POLICY, useValue: createGoogleBrowserPolicy({ callbackUrl: `${origin}/auth/google/callback`, webOrigin: origin }) },
    { provide: LinguaLoopTokenService, useValue: { async verifyBearerToken(token) { if (token !== 'valid') throw new InvalidBearerTokenError(); return { issuer: 'local', subject: ownerId, sessionId: S, role: 'admin' }; } } },
    { provide: LINGUALOOP_IDENTITY_STORE, useValue: { async findOwnerByIdentity() { return ownerId; }, async findAccountByOwner() { return { name: 'Persisted Account', email: 'approved@example.test', role }; } } },
    { provide: LINGUALOOP_SESSION_STORE, useValue: { async isSessionActive() { return true; } } },
    { provide: PRACTICE_CATALOGUE_STORE, useValue: catalogue },
    { provide: LANGUAGE_PRACTICE_REPORT_STORE, useValue: { async findTeacherReport() { throw Error('unused in this test'); } } },
    { provide: LANGUAGE_PRACTICE_SESSION_STORE, useValue: {
      async createSession(owner, value) { calls.push(['default', owner, value]); return session; },
      async createCustomSession(owner, id) { calls.push(['custom', owner, id]); if (dependencyFailure) throw Error('PRIVATE'); return id === P ? session : null; },
      async getSession(owner, id) { calls.push(['get', owner, id]); return owner === A && id === S ? session : null; },
      async finishSession(owner, id) { calls.push(['finish', owner, id]); return owner === A && id === S ? { id, status: 'COMPLETED' } : null; },
    } },
    { provide: LANGUAGE_PRACTICE_TURN_STORE, useValue: { async listCompletedTurns() { return []; } } },
    { provide: LANGUAGE_PRACTICE_REPORT_SERVICE, useValue: { async getOrCreate(owner, id) { calls.push(['report', owner, id]); return { sessionId: id, parameterCoverage: [] }; } } },
    { provide: LANGUAGE_PRACTICE_TURN_SERVICE, useValue: { async processTurn() { throw Error('Should not run for denied roles'); } } },
    { provide: PracticeAudioService, useValue: { async transcribe() { return 'offline'; } } },
    { provide: PIPER_RUNTIME, useValue: { getHost() { return { async synthesize() { return Buffer.from('wav'); } }; } } },
  ] })(OfflineModule);
  const app = await NestFactory.create(OfflineModule, { logger: false, abortOnError: false });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function request(path, method = 'GET', body, token = 'valid') {
    const response = await fetch(base + path, { method, headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const studentRoutes = [
    ['/language-practice/options', 'GET'], ['/language-practice/sessions', 'POST', setup],
    [`/language-practice/sessions/${S}`, 'GET'], [`/language-practice/sessions/${S}/finish`, 'POST'],
    [`/language-practice/sessions/${S}/report`, 'POST'], [`/language-practice/sessions/${S}/turns`, 'POST'],
    ['/practice/transcribe', 'POST'], ['/practice/synthesize', 'POST', { text: 'Hello', language: 'en' }],
  ];
  for (const next of ['teacher', 'admin']) {
    role = next;
    for (const args of studentRoutes) assert.equal((await request(...args)).status, 403, `${next}: ${args[0]}`);
  }
  for (const args of studentRoutes) assert.equal((await request(args[0], args[1], args[2], null)).status, 401);
  assert.deepEqual(calls, [], 'denied roles never access domain dependencies');
  for (const next of ['student', 'admin']) {
    role = next;
    assert.equal((await request('/language-practice/practices', 'POST', input)).status, 403);
  }
  role = 'admin';
  for (const path of ['/language-practice/practices', `/language-practice/practices/${P}`]) assert.equal((await request(path)).status, 403);
  role = 'teacher';
  for (const invalid of [null, [], {}, { ...input, teacherId: B }, { ...input, title: '' }, { ...input, title: 'x'.repeat(121) }, { ...input, parameters: [] }, { ...input, parameters: Array(21).fill({ requirement: 'x' }) }, { ...input, parameters: [{ requirement: 'x'.repeat(501) }] }, { ...input, setup }, { ...input, setup: { ...input.setup, x: 1 } }, { ...input, parameters: [{ id: P, requirement: 'x' }] }]) assert.equal((await request('/language-practice/practices', 'POST', invalid)).status, 400);
  const first = await request('/language-practice/practices', 'POST', input);
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.body).sort(), ['activity', 'createdAt', 'hasImage', 'id', 'parameters', 'setup', 'teacherId', 'teacherName', 'title']);
  assert.equal(first.body.hasImage, false);
  assert.deepEqual(first.body.setup, { ...input.setup, topic: 'everyday-conversation', difficulty: 'medium' });
  assert.equal(first.body.teacherId, A);
  assert.match(first.body.parameters[0].id, /^[0-9a-f-]{36}$/);
  ownerId = B;
  const second = await request('/language-practice/practices', 'POST', { ...input, title: 'Other teacher' });
  assert.equal(second.status, 201);
  assert.deepEqual((await request('/language-practice/practices')).body, { practices: [second.body] });
  assert.equal((await request(`/language-practice/practices/${P}`)).status, 404);
  assert.deepEqual((await request(`/language-practice/practices/${Q}`)).body, second.body);
  role = 'student';
  assert.deepEqual((await request('/language-practice/practices')).body, { practices: [first.body, second.body] });
  assert.deepEqual((await request(`/language-practice/practices/${P}`)).body, first.body);
  assert.equal((await request('/language-practice/practices/not-an-id')).status, 404);
  assert.equal((await request(`/language-practice/practices/${S}`)).status, 404);
  for (const invalid of [{ practiceId: P, ...setup }, { practiceId: P, level: 'A1' }, { practiceId: P, parameters: [] }, { practiceId: P, ownerId: A }, { practiceId: 3 }, { practiceId: 'bad' }, { ...setup, extra: true }]) assert.equal((await request('/language-practice/sessions', 'POST', invalid)).status, 400);
  const custom = await request('/language-practice/sessions', 'POST', { practiceId: P });
  assert.equal(custom.status, 201);
  assert.deepEqual(custom.body, { ...session, turns: [] });
  assert.deepEqual(calls, [['custom', B, P]]);
  assert.equal((await request('/language-practice/sessions', 'POST', { practiceId: Q })).status, 404);
  assert.equal((await request(`/language-practice/sessions/${S}`)).status, 404, 'student ownership remains enforced');
  assert.equal((await request(`/language-practice/sessions/${S}/finish`, 'POST')).status, 404);
  dependencyFailure = true;
  for (const [path, method, body] of [['/language-practice/practices', 'GET'], [`/language-practice/practices/${P}`, 'GET'], ['/language-practice/sessions', 'POST', { practiceId: P }]]) {
    const failed = await request(path, method, body);
    assert.equal(failed.status, 503); assert.equal(JSON.stringify(failed.body).includes('PRIVATE'), false);
  }
  role = 'teacher';
  assert.equal((await request('/language-practice/practices', 'POST', input)).status, 503);
});
