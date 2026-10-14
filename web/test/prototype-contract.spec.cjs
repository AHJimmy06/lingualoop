const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const { AuthSession } = require('../src/auth-session.ts');
const { parseProfile } = require('../src/features/auth/profile.ts');
const { resolveRoute } = require('../src/react-route-policy.ts');
const id = '123e4567-e89b-42d3-a456-426614174000';
const other = '123e4567-e89b-42d3-a456-426614174001';
const date = '2026-01-01T00:00:00.000Z';
const profile = { ownerId: id, name: 'Student', email: 'student@example.com', role: 'student' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
test('password login sends exact credentials then restores authoritative profile, including after local logout', async () => {
  const calls = [];
  const auth = new AuthSession(async (url, init) => {
    calls.push({ url, init });
    return json(url.endsWith('/login') ? { authenticated: true } : url.endsWith('/refresh') ? { accessToken: 'volatile' } : profile);
  });
  auth.clearLocal();
  assert.equal(await auth.login({ email: profile.email, password: ' password ' }), 'authenticated');
  assert.deepEqual(calls.map(c => c.url), ['/api/auth/login', '/api/auth/refresh', '/api/auth/me']);
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: profile.email, password: ' password ' });
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.deepEqual(auth.profile, profile);
  assert.equal(parseProfile({ ...profile, password: 'hidden' }), null);
  assert.equal(parseProfile({ ...profile, name: ' ' }), null);
});
test('login fails closed for malformed, rejected and late responses without cookie refresh replay', async () => {
  for (const [status, body, expected] of [[401, {}, 'invalid-credentials'], [400, {}, 'invalid-input'], [429, {}, 'rate-limited'], [403, {}, 'forbidden'], [200, { authenticated: true, accessToken: 'bad' }, 'unavailable']]) {
    const calls = [];
    const auth = new AuthSession(async url => { calls.push(url); return json(body, status); });
    assert.equal(await auth.login({ email: profile.email, password: 'password' }), expected);
    assert.deepEqual(calls, ['/api/auth/login']);
    assert.equal(auth.authenticated, false);
  }
  let resolve;
  const auth = new AuthSession(() => new Promise(done => { resolve = done; }));
  const pending = auth.login({ email: profile.email, password: 'password' });
  auth.clearLocal(); resolve(json({ authenticated: true }));
  assert.equal(await pending, 'no-session');
  assert.equal(auth.profile, null);
  const invalid = new AuthSession(() => { throw Error('must not transport'); });
  for (const input of [{ email: 'bad', password: 'password' }, { email: profile.email, password: 'short' }, { email: profile.email, password: 'x'.repeat(129) }, { email: profile.email, password: 'password', extra: true }]) assert.equal(await invalid.login(input), 'invalid-input');
});
test('default preferences are validated, isolated by owner and tolerate unavailable storage', () => {
  const { readPreferences, savePreferences } = require('../src/features/language-practice/practice-preferences.ts');
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.deepEqual(readPreferences(id, storage), { level: 'A1', durationMinutes: 5, difficulty: 'medium' });
  assert.equal(savePreferences(id, { level: 'C2', durationMinutes: 15, difficulty: 'hard' }, storage), true);
  assert.deepEqual(readPreferences(id, storage), { level: 'C2', durationMinutes: 15, difficulty: 'hard' });
  assert.deepEqual(readPreferences(other, storage), { level: 'A1', durationMinutes: 5, difficulty: 'medium' });
  assert.equal(savePreferences(id, { level: 'C3', durationMinutes: 20, difficulty: 'medium' }, storage), false);
  const key = [...values.keys()][0];
  for (const value of ['bad JSON', '{"level":"C3","durationMinutes":5}', '{"level":"B1","durationMinutes":10,"token":"bad"}']) {
    values.set(key, value);
    assert.deepEqual(readPreferences(id, storage), { level: 'A1', durationMinutes: 5, difficulty: 'medium' });
  }
  values.set(key, '{"level":"B1","durationMinutes":10}');
  assert.deepEqual(readPreferences(id, storage), { level: 'B1', durationMinutes: 10, difficulty: 'medium' });
  assert.deepEqual(readPreferences(other, storage), { level: 'A1', durationMinutes: 5, difficulty: 'medium' });
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.deepEqual(readPreferences(id, denied), { level: 'A1', durationMinutes: 5, difficulty: 'medium' });
  assert.equal(savePreferences(id, { level: 'B1', durationMinutes: 10, difficulty: 'medium' }, denied), false);
  assert.equal(savePreferences('invalid', { level: 'B1', durationMinutes: 10, difficulty: 'medium' }, storage), false);
});
test('account listing accepts bootstrap admin with student but rejects unknown roles and private fields', async () => {
  const { AdminAccountsClient } = require('../src/features/admin/admin-client.ts');
  const admin = { id, name: 'Administrator', email: 'admin@example.com', role: 'admin', createdAt: date };
  const student = { ...admin, id: other, name: 'Student', email: profile.email, role: 'student' };
  let body = { accounts: [admin, student] };
  let posts = 0;
  const client = new AdminAccountsClient({
    getWithRefresh: async () => json(body),
    postAdminAccounts: async () => { posts++; return json(admin, 201); },
  });
  assert.deepEqual(await client.listAccounts(), [admin, student]);
  for (const invalid of [{ ...admin, role: 'unknown' }, { ...admin, password: 'private' }, { ...admin, passwordHash: 'private' }, { ...admin, linked: true }]) {
    body = { accounts: [invalid, student] };
    await assert.rejects(client.listAccounts(), { kind: 'invalid-response' });
  }
  await assert.rejects(client.createAccount({ name: admin.name, email: admin.email, password: 'password', role: 'admin' }), { kind: 'invalid-input' });
  assert.equal(posts, 0, 'listing administrator accounts must not authorize administrator creation');
  await assert.rejects(client.createAccount({ name: student.name, email: student.email, password: 'password', role: 'student' }), { kind: 'invalid-response' });
  assert.equal(posts, 1, 'a create response must still reject an unexpected administrator role');
});
test('teacher result routes never open student routes to other roles', () => {
  for (const path of [`/teacher/practices/${id}/results`, `/teacher/practices/${id}/results/${other}`]) {
    assert.deepEqual(resolveRoute(path, '', 'authenticated', 'teacher'), { kind: 'render' });
    for (const [role, home] of [['student', '/language-practice'], ['admin', '/admin']]) assert.deepEqual(resolveRoute(path, '', 'authenticated', role), { kind: 'redirect', to: home });
  }
  assert.deepEqual(resolveRoute('/language-practice', '', 'authenticated', 'teacher'), { kind: 'redirect', to: '/teacher' });
});
test('teacher submissions and saved report use GET only, strict DTOs and nullable completion', async () => {
  const { TeacherResultsClient } = require('../src/features/teacher/teacher-results-client.ts');
  const submission = { sessionId: other, studentId: id, studentName: 'Student', studentEmail: profile.email, status: 'EXPIRED', startedAt: date, completedAt: null, reportAvailable: true };
  const report = { sessionId: other, summary: 'Saved summary', corrections: [], strengths: [], recommendations: [], generatedWithAi: true, createdAt: date, parameterCoverage: [] };
  const calls = []; let body = { submissions: [submission] }; let status = 200;
  const client = new TeacherResultsClient({ getWithRefresh: async url => { calls.push(url); return json(body, status); }, postLanguagePractice: () => { throw Error('no generation'); } });
  assert.deepEqual(await client.listSubmissions(id), [submission]);
  body = report;
  assert.deepEqual(await client.getReport(id, other), report);
  assert.deepEqual(calls, [`/api/language-practice/practices/${id}/submissions`, `/api/language-practice/practices/${id}/submissions/${other}/report`]);
  for (const invalid of [{ ...submission, password: 'bad' }, { ...submission, reportAvailable: 'true' }, { ...submission, status: ['EXPIRED'] }, { ...submission, completedAt: 'bad' }, { ...submission, studentEmail: 'bad' }]) {
    body = { submissions: [invalid] };
    await assert.rejects(client.listSubmissions(id), { kind: 'invalid-response' });
  }
  body = { submissions: [submission, submission] };
  await assert.rejects(client.listSubmissions(id), { kind: 'invalid-response' });
  body = { ...report, sessionId: id };
  await assert.rejects(client.getReport(id, other), { kind: 'invalid-response' });
  for (const [code, kind] of [[404, 'not-found'], [403, 'forbidden']]) { status = code; await assert.rejects(client.getReport(id, other), { kind }); }
  const before = calls.length;
  await assert.rejects(client.getReport('invalid', other), { kind: 'invalid-input' });
  assert.equal(calls.length, before);
});
