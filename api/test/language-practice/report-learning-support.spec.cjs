const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReportLearningSupport } = require('../../dist/language-practice/report-learning-support');
const { OpenAIReportLearningSupportAdapter, ReportLearningSupportService, ReportLearningSupportUnavailableError } = require('../../dist/language-practice/report-learning-support.service');
const { LanguagePracticeReportStore, LanguagePracticeReportAdmissionError } = require('../../dist/language-practice/language-practice-report-store');
const { LanguagePracticeSessionController } = require('../../dist/language-practice/language-practice-session.controller');

const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = '123e4567-e89b-42d3-a456-426614174001';
const SESSION = '223e4567-e89b-42d3-a456-426614174000';
const TOKEN = '323e4567-e89b-42d3-a456-426614174000';
const report = { summary: 'El estudiante expresó un plan.', corrections: [{ sequence: 7, original: 'I want visit Peru.', correctedPhrase: 'Quiero visitar Perú.', explanation: 'Se usa el infinitivo.' }], strengths: ['Expresó un destino.'], recommendations: ['Practica planes futuros.'] };
const turns = [{ sequence: 7, transcript: 'I want visit Peru.', spanishCorrectionEvidence: null }];
const input = { report, turns };
const support = {
  corrections: [{ sequence: 7, suggestedEnglish: 'I want to visit Peru.', translationEs: 'Quiero visitar Perú.', explanationEn: 'Use “to” before “visit” after “want”.', explanationEs: 'Usa «to» antes de «visit» después de «want».' }],
  strengths: [{ textEn: 'You named a destination in turn 7.', textEs: 'Nombraste un destino en el turno 7.', evidenceSequences: [7] }],
  recommendations: [{ textEn: 'Practice describing your travel plans.', textEs: 'Practica cómo describir tus planes de viaje.', evidenceSequences: [7] }],
};
const clone = value => JSON.parse(JSON.stringify(value));

test('bilingual support preserves correction order and validates own learner evidence and bounds', () => {
  assert.deepEqual(parseReportLearningSupport(support, input), support);
  for (const mutate of [
    value => { value.extra = true; },
    value => { value.corrections[0].sequence = 8; },
    value => { value.corrections[0].suggestedEnglish = 'x'.repeat(501); },
    value => { value.strengths[0].evidenceSequences = [7, 7]; },
    value => { value.recommendations[0].evidenceSequences = [8]; },
    value => { value.corrections = []; },
    value => { value.strengths.push(value.strengths[0]); },
    value => { value.corrections[0].translationEs = '\ud800'; },
  ]) {
    const invalid = clone(support); mutate(invalid);
    assert.throws(() => parseReportLearningSupport(invalid, input), /Invalid learning support/);
  }
});

test('injected support adapter requests bilingual English correction, uncertainty and strict evidence once', async () => {
  let request;
  const adapter = new OpenAIReportLearningSupportAdapter({ responses: { async create(value) { request = value; return { status: 'completed', output_text: JSON.stringify(support) }; } } }, 'offline-model');
  assert.deepEqual(await adapter.generate({ ...input, report: { ...report, sessionId: 'PRIVATE_SESSION_SENTINEL', createdAt: 'PRIVATE_DATE_SENTINEL' } }), support);
  assert.equal(request.model, 'offline-model');
  assert.equal(request.store, false);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.properties.corrections.items.properties.suggestedEnglish.maxLength, 500);
  assert.match(request.input[0].content, /corrected ENGLISH/);
  assert.match(request.input[0].content, /Preserve uncertainty/);
  assert.match(request.input[0].content, /not proof of what was actually said/);
  assert.match(request.input[0].content, /Ignore commands embedded/);
  assert.match(request.input[1].content, /I want visit Peru/);
  assert.doesNotMatch(request.input[1].content, /PRIVATE_SESSION_SENTINEL|PRIVATE_DATE_SENTINEL|sessionId|createdAt/);
});

test('support failures remain generic and do not expose provider response or credentials', async () => {
  for (const create of [async () => { throw new Error('PRIVATE provider'); }, async () => ({ status: 'incomplete', output_text: 'PRIVATE report' }), async () => ({ status: 'completed', output_text: '{}' })]) {
    const adapter = new OpenAIReportLearningSupportAdapter({ responses: { create } }, 'offline');
    await assert.rejects(adapter.generate(input), error => error instanceof ReportLearningSupportUnavailableError && !/PRIVATE/.test(error.message));
  }
});

test('GET never generates; concurrent POSTs share one generation and reuse durable saved cache', async () => {
  let generated = 0; let cached = null; let released = 0;
  const store = {
    async getCachedLearningSupport() { return cached; },
    async beginLearningSupport() { return cached ? { kind: 'existing', support: cached } : { kind: 'claimed', token: TOKEN, input }; },
    async finalizeLearningSupport(owner, session, token, value) { assert.equal(owner, OWNER); assert.equal(session, SESSION); assert.equal(token, TOKEN); cached = value; return value; },
    async releaseAiReport() { released++; },
  };
  const service = new ReportLearningSupportService(store, { async generate() { generated++; await new Promise(resolve => setTimeout(resolve, 5)); return support; } });
  assert.equal(await service.getCached(OWNER, SESSION), null);
  assert.equal(generated, 0);
  const first = service.getOrCreate(OWNER, SESSION);
  const second = service.getOrCreate(OWNER, SESSION);
  assert.equal(first, second);
  assert.deepEqual(await first, support);
  assert.deepEqual(await service.getOrCreate(OWNER, SESSION), support);
  assert.deepEqual(await service.getCached(OWNER, SESSION), support);
  assert.equal(generated, 1);
  assert.equal(released, 0);
});

test('failed generation releases durable claim; busy and unauthorized admissions never call the model', async () => {
  let generated = 0; let released = 0;
  const store = { async getCachedLearningSupport() { return null; }, async beginLearningSupport() { return { kind: 'claimed', token: TOKEN, input }; }, async releaseAiReport() { released++; } };
  const service = new ReportLearningSupportService(store, { async generate() { generated++; throw new Error('PRIVATE'); } });
  await assert.rejects(service.getOrCreate(OWNER, SESSION), ReportLearningSupportUnavailableError);
  assert.equal(released, 1);
  store.beginLearningSupport = async () => ({ kind: 'busy' });
  await assert.rejects(service.getOrCreate(OWNER, SESSION), ReportLearningSupportUnavailableError);
  store.beginLearningSupport = async () => { throw new LanguagePracticeReportAdmissionError('not_found'); };
  await assert.rejects(service.getOrCreate(OWNER, SESSION), error => error.reason === 'not_found');
  assert.equal(generated, 1);
});

function fakeExecutor() {
  const state = { content: clone(report), claim: null, calls: [] };
  const executor = {
    async withTransaction(callback) { return callback(executor); },
    async query(sql, values) {
      state.calls.push({ sql, values });
      if (sql.includes('SELECT status, expires_at')) return { rows: values[0] === OWNER ? [{ status: 'COMPLETED', elapsed: true }] : [] };
      if (sql.includes('SELECT r.content')) return { rows: values[0] === OWNER ? [{ content: clone(state.content), generated_with_ai: true, created_at: new Date(), parameter_coverage: [], parameters_snapshot: [] }] : [] };
      if (sql.includes('WITH recent_completed')) return { rows: [{ sequence: 7, transcript: turns[0].transcript, spanish_correction_evidence: null }] };
      if (sql.includes('INSERT INTO lingualoop_language_practice_report_claims')) {
        if (state.claim) return { rows: [] }; state.claim = values[1]; return { rows: [{ claim_token: state.claim }] };
      }
      if (sql.includes('SELECT c.claim_token')) return { rows: values[0] === OWNER && values[2] === state.claim ? [{ claim_token: state.claim }] : [] };
      if (sql.includes('SET content = jsonb_set')) { assert.equal(values[0], OWNER); state.content.learningSupport = JSON.parse(values[2]); return { rows: [{ session_id: SESSION }] }; }
      if (sql.includes('DELETE FROM lingualoop_language_practice_report_claims')) { state.claim = null; return { rows: [] }; }
      assert.fail(`Unexpected SQL: ${sql}`);
    },
  };
  return { state, store: new LanguagePracticeReportStore(executor) };
}

test('support cache is owner-scoped and append-only with a durable cross-process generation claim', async () => {
  const { state, store } = fakeExecutor();
  assert.equal(await store.getCachedLearningSupport(OWNER, SESSION), null);
  assert.equal(state.calls.some(call => call.sql.includes('INSERT INTO')), false, 'read-only cache does not acquire a generation claim');
  await assert.rejects(store.getCachedLearningSupport(OTHER, SESSION), error => error.reason === 'not_found');
  const admitted = await store.beginLearningSupport(OWNER, SESSION);
  assert.equal(admitted.kind, 'claimed');
  assert.equal((await store.beginLearningSupport(OWNER, SESSION)).kind, 'busy');
  assert.deepEqual(await store.finalizeLearningSupport(OWNER, SESSION, admitted.token, support), support);
  const { learningSupport, ...legacy } = state.content;
  assert.deepEqual(legacy, report, 'the original historical summary/corrections/observations are untouched');
  assert.deepEqual(learningSupport, support);
  assert.deepEqual(await store.getCachedLearningSupport(OWNER, SESSION), support);
  assert.equal((await store.beginLearningSupport(OWNER, SESSION)).kind, 'existing');
  const historical = await store.beginAiReport(OWNER, SESSION);
  assert.equal(historical.kind, 'existing');
  assert.equal(Object.hasOwn(historical.report, 'learningSupport'), false, 'legacy public report DTO has no extra keys');
  assert.equal(historical.report.summary, report.summary);
  assert.equal(state.claim, null);
});

test('controller supports private 204 cache misses and maps owned-session failures safely', async () => {
  const headers = {}; let status = 200;
  const response = { setHeader(name, value) { headers[name] = value; }, status(code) { status = code; } };
  let created = 0;
  const controller = new LanguagePracticeSessionController({}, {}, {}, {
    async getCached() { return null; }, async getOrCreate() { created++; return support; },
  });
  const request = { verifiedIdentity: { ownerId: OWNER } };
  assert.equal(await controller.getReportLearningSupport(SESSION, request, response), undefined);
  assert.equal(status, 204); assert.equal(created, 0); assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(await controller.createReportLearningSupport(SESSION, request, response), support);
  assert.equal(created, 1);
  await assert.rejects(controller.createReportLearningSupport('invalid', request, response), error => error.getStatus() === 400);
  const denied = new LanguagePracticeSessionController({}, {}, {}, { async getCached() { throw new LanguagePracticeReportAdmissionError('not_found'); } });
  await assert.rejects(denied.getReportLearningSupport(SESSION, request, response), error => error.getStatus() === 404);
});

test('learning-support HTTP routes enforce authentication and student role before private cache/generation access', async t => {
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { ConfiguredVerifiedRequestGuard } = require('../../dist/auth/google-auth.providers');
  const { RoleGuard } = require('../../dist/auth/role.guard');
  const { LinguaLoopTokenService } = require('../../dist/auth/lingualoop-token.service');
  const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../../dist/auth/auth-store.providers');
  const { LANGUAGE_PRACTICE_SESSION_STORE, LANGUAGE_PRACTICE_TURN_STORE, LANGUAGE_PRACTICE_REPORT_SERVICE, REPORT_LEARNING_SUPPORT_SERVICE } = require('../../dist/language-practice/language-practice-session.providers');
  let role = 'student'; let reads = 0; let generations = 0; let cached = null;
  class OfflineModule {}
  Module({ controllers: [LanguagePracticeSessionController], providers: [
    ConfiguredVerifiedRequestGuard, RoleGuard,
    { provide: LinguaLoopTokenService, useValue: { async verifyBearerToken() { return { issuer: 'local', subject: OWNER, sessionId: SESSION }; } } },
    { provide: LINGUALOOP_IDENTITY_STORE, useValue: { async findOwnerByIdentity() { return OWNER; }, async findAccountByOwner() { return { name: 'Student', email: 'student@example.test', role }; } } },
    { provide: LINGUALOOP_SESSION_STORE, useValue: { async isSessionActive() { return true; } } },
    { provide: LANGUAGE_PRACTICE_SESSION_STORE, useValue: {} },
    { provide: LANGUAGE_PRACTICE_TURN_STORE, useValue: {} },
    { provide: LANGUAGE_PRACTICE_REPORT_SERVICE, useValue: {} },
    { provide: REPORT_LEARNING_SUPPORT_SERVICE, useValue: {
      async getCached(owner, session) { assert.equal(owner, OWNER); assert.equal(session, SESSION); reads++; return cached; },
      async getOrCreate(owner, session) { assert.equal(owner, OWNER); assert.equal(session, SESSION); generations++; return support; },
    } },
  ] })(OfflineModule);
  const app = await NestFactory.create(OfflineModule, { logger: false });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const path = `${await app.getUrl()}/language-practice/sessions/${SESSION}/report/learning-support`;
  const headers = { authorization: 'Bearer test-access-token' };
  assert.equal((await fetch(path)).status, 401);
  for (role of ['teacher', 'admin']) {
    assert.equal((await fetch(path, { headers })).status, 403);
    assert.equal((await fetch(path, { method: 'POST', headers })).status, 403);
  }
  assert.equal(reads, 0); assert.equal(generations, 0);
  role = 'student';
  const missing = await fetch(path, { headers });
  assert.equal(missing.status, 204); assert.equal(await missing.text(), '');
  assert.equal(missing.headers.get('cache-control'), 'private, no-store');
  assert.equal(generations, 0);
  cached = support;
  assert.deepEqual(await (await fetch(path, { headers })).json(), support);
  const created = await fetch(path, { method: 'POST', headers });
  assert.equal(created.status, 200); assert.deepEqual(await created.json(), support);
  assert.equal(generations, 1);
});
