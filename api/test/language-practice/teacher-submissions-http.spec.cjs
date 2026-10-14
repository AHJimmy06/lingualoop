const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { ConfiguredVerifiedRequestGuard } = require('../../dist/auth/google-auth.providers.js');
const { RoleGuard } = require('../../dist/auth/role.guard.js');
const { LinguaLoopTokenService } = require('../../dist/auth/lingualoop-token.service.js');
const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../../dist/auth/auth-store.providers.js');
const { PracticeCatalogueController } = require('../../dist/language-practice/practice-catalogue.controller.js');
const { PracticeCatalogueStore, PRACTICE_CATALOGUE_STORE } = require('../../dist/language-practice/practice-catalogue.js');
const { LanguagePracticeReportStore } = require('../../dist/language-practice/language-practice-report-store.js');
const { LANGUAGE_PRACTICE_REPORT_STORE } = require('../../dist/language-practice/language-practice-session.providers.js');
const A = '123e4567-e89b-42d3-a456-426614174000';
const B = '123e4567-e89b-42d3-a456-426614174001';
const P = '223e4567-e89b-42d3-a456-426614174000';
const S = '323e4567-e89b-42d3-a456-426614174000';
const PARAM = '423e4567-e89b-42d3-a456-426614174000';
const requirement = 'Explain your destination';
const reportRow = { content: { summary: 'Persisted summary', corrections: [], strengths: [], recommendations: [] }, generated_with_ai: true, created_at: '2026-01-01', parameters_snapshot: [{ id: PARAM, requirement }], parameter_coverage: [{ parameterId: PARAM, requirement, status: 'met', evidenceSequences: [1], explanation: 'Destination given.' }], student_sequences: [1] };
test('teacher HTTP results are private, owner-isolated, read-only and identical to persisted student DTO', async t => {
  let role = 'teacher'; let owner = A; let available = true; let failure = false;
  const calls = [];
  const executor = { async withTransaction() { throw Error('teacher must not generate or lock'); }, async query(sql, values) {
    calls.push({ sql, values }); if (failure) throw Error('PRIVATE');
    if (sql.includes('SELECT id FROM lingualoop_practices')) return { rows: values[0] === P && values[1] === A ? [{ id: P }] : [] };
    if (sql.includes('SELECT r.content')) return { rows: values[0] === A && values[1] === P && values[2] === S && available ? [reportRow] : [] };
    return { rows: values[0] === P && values[1] === A ? [{ session_id: S, student_id: B, student_name: 'Student B', student_email: 'student@example.test', status: 'COMPLETED', started_at: '2026-01-01', completed_at: '2026-01-01T00:04:00Z', report_available: available }] : [] };
  } };
  const reports = new LanguagePracticeReportStore(executor);
  const expected = (await reports.findTeacherReport(A, P, S)); calls.length = 0;
  const tokens = new LinguaLoopTokenService(new JwtService({}), 'offline-teacher-http-signing-key-32-characters');
  const signed = {};
  for (const id of [A, B]) signed[id] = await tokens.issue({ issuer: 'local', subject: id, sessionId: S });
  class OfflineModule {}
  Module({ controllers: [PracticeCatalogueController], providers: [ConfiguredVerifiedRequestGuard, RoleGuard,
    { provide: LinguaLoopTokenService, useValue: tokens },
    { provide: LINGUALOOP_IDENTITY_STORE, useValue: { async findOwnerByIdentity(identity) { return identity.subject; }, async findAccountByOwner() { return { name: 'Persisted User', email: 'user@example.test', role }; } } },
    { provide: LINGUALOOP_SESSION_STORE, useValue: { async isSessionActive() { return true; } } },
    { provide: PRACTICE_CATALOGUE_STORE, useValue: new PracticeCatalogueStore(executor) },
    { provide: LANGUAGE_PRACTICE_REPORT_STORE, useValue: reports },
  ] })(OfflineModule);
  const app = await NestFactory.create(OfflineModule, { logger: false, abortOnError: false });
  t.after(() => app.close()); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const listPath = `/language-practice/practices/${P}/submissions`;
  const reportPath = `${listPath}/${S}/report`;
  const request = (path, token = signed[owner]) => fetch(base + path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-role': 'teacher' } });
  for (const path of [listPath, reportPath]) for (const token of [null, 'bad']) {
    const denied = await request(path, token); assert.equal(denied.status, 401);
    assert.match(denied.headers.get('cache-control'), /private, no-store/);
  }
  for (const next of ['student', 'admin']) { role = next; for (const path of [listPath, reportPath]) assert.equal((await request(path)).status, 403); }
  assert.deepEqual(calls, []);
  role = 'teacher'; owner = B;
  for (const path of [listPath, reportPath]) assert.equal((await request(path)).status, 404);
  owner = A;
  const list = await request(listPath); assert.equal(list.status, 200); assert.match(list.headers.get('cache-control'), /private, no-store/);
  assert.deepEqual(await list.json(), { submissions: [{ sessionId: S, studentId: B, studentName: 'Student B', studentEmail: 'student@example.test', status: 'COMPLETED', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:04:00.000Z', reportAvailable: true }] });
  for (let read = 0; read < 2; read++) {
    const response = await request(reportPath); assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private, no-store/); assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.deepEqual(await response.json(), expected);
  }
  available = false;
  const missing = await request(reportPath); assert.equal(missing.status, 404);
  assert.match(missing.headers.get('cache-control'), /private, no-store/);
  for (const path of ['/language-practice/practices/bad/submissions', `${listPath}/bad/report`, `${listPath}/${P}/report`]) assert.equal((await request(path)).status, 404);
  failure = true;
  for (const path of [listPath, reportPath]) { const response = await request(path); assert.equal(response.status, 503); assert.equal((await response.text()).includes('PRIVATE'), false); }
  assert.equal(calls.some(call => /\b(?:INSERT|UPDATE|DELETE|FOR UPDATE)\b/.test(call.sql)), false);
});
