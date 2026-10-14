const test = require('node:test');
const assert = require('node:assert/strict');
const { PracticeCatalogueStore } = require('../../dist/language-practice/practice-catalogue.js');
const { LanguagePracticeReportStore } = require('../../dist/language-practice/language-practice-report-store.js');
const { LanguagePracticeSessionStore } = require('../../dist/language-practice/language-practice-session-store.js');
const A = '123e4567-e89b-42d3-a456-426614174000';
const P = '223e4567-e89b-42d3-a456-426614174000';
const S = '323e4567-e89b-42d3-a456-426614174000';
const content = { summary: 'Stored report', corrections: [], strengths: [], recommendations: [] };
test('teacher submissions use persisted ownership joins, exact projection, no expiry completion fiction', async () => {
  const calls = [];
  const store = new PracticeCatalogueStore({ async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('SELECT id FROM lingualoop_practices')) return { rows: [{ id: P }] };
    return { rows: [{ session_id: S, student_id: A, student_name: 'Student', student_email: 'student@example.test', status: 'EXPIRED', started_at: '2026-01-01', completed_at: null, report_available: false }] };
  } });
  assert.deepEqual(await store.submissions(A, P), [{ sessionId: S, studentId: A, studentName: 'Student', studentEmail: 'student@example.test', status: 'EXPIRED', startedAt: '2026-01-01T00:00:00.000Z', completedAt: null, reportAvailable: false }]);
  assert.deepEqual(calls.at(-1).values, [P, A]);
  assert.match(calls.at(-1).sql, /p.teacher_id = \$2::uuid/);
  assert.match(calls.at(-1).sql, /JOIN lingualoop_accounts/);
  assert.equal(await new PracticeCatalogueStore({ async query() { return { rows: [] }; } }).submissions(A, P), null);
});
test('teacher reads only existing immutable report through bound practice ownership and shared parser', async () => {
  const calls = [];
  const executor = { async withTransaction() { throw Error('teacher read must not transact or generate'); }, async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{ content, generated_with_ai: false, created_at: '2026-01-01', parameters_snapshot: [], parameter_coverage: [], student_sequences: [] }] };
  } };
  const report = await new LanguagePracticeReportStore(executor).findTeacherReport(A, P, S);
  assert.deepEqual(report, { ...content, sessionId: S, createdAt: '2026-01-01T00:00:00.000Z', generatedWithAi: false, parameterCoverage: [] });
  assert.equal(calls.length, 1);
  // The student's cached path uses exactly the same snapshot/coverage projection.
  const student = new LanguagePracticeReportStore({ async withTransaction(callback) { return callback(this); }, async query(sql) {
    if (sql.includes('FOR UPDATE')) return { rows: [{ status: 'ACTIVE' }] };
    return { rows: [{ content, generated_with_ai: false, created_at: '2026-01-01', parameters_snapshot: [], parameter_coverage: [], student_sequences: [] }] };
  } });
  assert.deepEqual(report, await student.getOrCreate(A, S));
  assert.deepEqual(calls[0].values, [A, P, S]);
  assert.match(calls[0].sql, /p.teacher_id = \$1::uuid AND p.id = \$2::uuid AND s.id = \$3::uuid/);
  assert.doesNotMatch(calls[0].sql, /INSERT|UPDATE|DELETE|FOR UPDATE/);
  assert.equal(await new LanguagePracticeReportStore({ ...executor, async query() { return { rows: [] }; } }).findTeacherReport(A, P, S), null);
  await assert.rejects(new LanguagePracticeReportStore({ ...executor, async query() { return { rows: [{ content: { ...content, extra: true }, generated_with_ai: false, created_at: '2026-01-01' }] }; } }).findTeacherReport(A, P, S));
});
test('successful explicit finish stamps completion once; expiry is not a completion timestamp', async () => {
  let sqlSeen;
  const store = new LanguagePracticeSessionStore({ async query(sql) { sqlSeen = sql; return { rows: [{ id: S, status: 'COMPLETED' }] }; } });
  await store.finishSession(A, S);
  assert.match(sqlSeen, /completed_at = COALESCE\(completed_at, clock_timestamp\(\)\)/);
  assert.match(sqlSeen, /status = 'ACTIVE'/);
  const calls = [];
  const legacy = new LanguagePracticeSessionStore({ async query(sql) {
    calls.push(sql);
    return { rows: sql.includes('UPDATE') ? [] : [{ id: S, status: 'ACTIVE', activeTurnLeaseToken: null, elapsed: true }] };
  } });
  assert.deepEqual(await legacy.finishSession(A, S), { id: S, status: 'EXPIRED' });
  assert.equal(calls.length, 2, 'no follow-up timestamp write for expired sessions');
});
