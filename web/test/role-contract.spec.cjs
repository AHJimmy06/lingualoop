const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const { AuthSession } = require('../src/auth-session.ts');
const { resolveRoute } = require('../src/react-route-policy.ts');
const { LanguagePracticeClient } = require('../src/features/language-practice/language-practice-client.ts');
const id = '123e4567-e89b-42d3-a456-426614174000';
const otherId = '123e4567-e89b-42d3-a456-426614174001';
const date = '2026-01-01T00:00:00.000Z';
const profile = { ownerId: id, name: 'Approved Student', email: 'approved@example.com', role: 'student' };
const setup = { topic: 'travel', level: 'B1', durationMinutes: 5 };
const practice = { id, teacherId: otherId, teacherName: 'Teacher One', title: 'Travel conversation', setup, hasImage: false, parameters: [{ id: otherId, requirement: 'Ask for directions' }], createdAt: date };
const session = { id, status: 'ACTIVE', ...setup, startedAt: date, expiresAt: date, remainingMs: 0, turnInProgress: false, turns: [] };
const report = { sessionId: id, summary: 'Summary', corrections: [], strengths: [], recommendations: [], generatedWithAi: true, createdAt: date, parameterCoverage: [] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function transport(handler, me = profile) {
  const calls = [];
  const auth = new AuthSession(async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/auth/refresh') return json({ accessToken: 'not-a-decoded-role' });
    if (url === '/api/auth/me') return me instanceof Response ? me : json(me);
    return handler(url, init);
  });
  return { auth, calls, client: new LanguagePracticeClient(auth) };
}
test('establishes exact authoritative profile after refresh and fails closed without refresh loops', async () => {
  const { auth, calls } = transport(() => json({}));
  assert.equal(await auth.refresh(), 'authenticated');
  assert.deepEqual(auth.profile, profile);
  assert.deepEqual(calls.map(c => c.url), ['/api/auth/refresh', '/api/auth/me']);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer not-a-decoded-role');
  for (const me of [null, { ...profile, role: 'unknown' }, { ...profile, role: ['student'] }, { ...profile, extra: true }, { ...profile, ownerId: 'bad' }, { ...profile, email: 'bad' }, json({}, 403)]) {
    const denied = transport(() => json({}), me);
    assert.notEqual(await denied.auth.refresh(), 'authenticated');
    assert.equal(denied.auth.authenticated, false);
    assert.equal(denied.auth.profile, null);
    assert.equal(denied.calls.filter(c => c.url.endsWith('/refresh')).length, 1);
  }
});
test('a late profile after local sign-out cannot restore permissions', async () => {
  let resolve;
  const pendingMe = new Promise(done => { resolve = done; });
  const auth = new AuthSession(async url => url.endsWith('/refresh') ? json({ accessToken: 'volatile' }) : pendingMe);
  const pending = auth.refresh();
  await new Promise(done => setImmediate(done));
  auth.clearLocal();
  resolve(json(profile));
  assert.equal(await pending, 'no-session');
  assert.equal(auth.profile, null);
  assert.equal(auth.authenticated, false);
});
test('terminal 401 clears both token and authoritative profile after one retry', async () => {
  const { auth, calls } = transport(() => json({}, 401));
  assert.equal((await auth.getWithRefresh('/api/language-practice/practices')).status, 401);
  assert.equal(auth.authenticated, false);
  assert.equal(auth.profile, null);
  assert.equal(calls.filter(c => c.url.endsWith('/refresh')).length, 2);
});
test('allowlisted admin POST preserves JSON across one 401 refresh and clears terminal auth', async () => {
  let posts = 0;
  const approval = { id, name: 'New Student', email: 'new@example.com', role: 'student', createdAt: date };
  const { auth, calls } = transport(() => ++posts === 1 ? json({}, 401) : json(approval, 201), { ...profile, role: 'admin' });
  const input = { name: approval.name, email: approval.email, password: 'exact password ', role: approval.role };
  assert.equal((await auth.postAdminAccounts('/api/admin/accounts', input)).status, 201);
  const requests = calls.filter(c => c.url === '/api/admin/accounts');
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(request.init.body), input);
  }
  assert.equal(calls.filter(c => c.url.endsWith('/refresh')).length, 2);
  const denied = transport(() => json({}, 401));
  assert.equal((await denied.auth.postAdminAccounts('/api/admin/accounts', input)).status, 401);
  assert.equal(denied.auth.profile, null);
  assert.equal(denied.auth.authenticated, false);
});
test('role route matrix denies direct forbidden routes and unknown profiles', () => {
  for (const [role, home] of [['admin', '/admin'], ['teacher', '/teacher'], ['student', '/language-practice']]) {
    for (const path of ['/admin', '/teacher', '/language-practice', `/language-practice/practices/${id}`, `/language-practice/sessions/${id}`, `/language-practice/sessions/${id}/complete`]) {
      const allowed = path === home || role === 'student' && path.startsWith('/language-practice');
      assert.deepEqual(resolveRoute(path, '', 'authenticated', role), allowed ? { kind: 'render' } : { kind: 'redirect', to: home });
    }
    assert.deepEqual(resolveRoute('/login', '', 'authenticated', role), { kind: 'redirect', to: home });
  }
  assert.deepEqual(resolveRoute('/admin', '', 'authenticated', null), { kind: 'redirect', to: '/login?status=forbidden' });
});
test('catalogue and custom start use exact API and reject mixed overrides before transport', async () => {
  const { client, calls } = transport((url) => url.endsWith('/sessions') ? json(session) : url.endsWith(`/practices/${id}`) ? json(practice) : json({ practices: [practice] }));
  const parsedPractice = { ...practice, setup: { ...setup, difficulty: null } };
  assert.deepEqual(await client.listPractices(), [parsedPractice]);
  assert.deepEqual(await client.getPractice(id), parsedPractice);
  assert.deepEqual(await client.createCustomSession({ practiceId: id }), { ...session, difficulty: null });
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { practiceId: id });
  assert.deepEqual(calls.filter(c => c.url.startsWith('/api/language-practice')).map(c => [c.url, c.init.method]), [
    ['/api/language-practice/practices', 'GET'], [`/api/language-practice/practices/${id}`, 'GET'], ['/api/language-practice/sessions', 'POST'],
  ]);
  const before = calls.length;
  for (const body of [{ practiceId: id, level: 'C2' }, { practiceId: id, topic: 'work' }, { practiceId: id, durationMinutes: 15 }, { practiceId: 'invalid' }, {}]) {
    await assert.rejects(client.createCustomSession(body), { kind: 'invalid-input' });
  }
  await assert.rejects(client.createSession({ ...setup, practiceId: id }), { kind: 'invalid-input' });
  assert.equal(calls.length, before);
});
test('coverage validates exact keys, unique ids, bounded text and positive turn evidence', async () => {
  const coverage = { parameterId: otherId, requirement: 'Ask for directions', status: 'unassessed', evidenceSequences: [], explanation: 'Insufficient evidence, not a failed requirement.' };
  let body = { ...report, parameterCoverage: [coverage] };
  const { client } = transport(() => json(body));
  assert.deepEqual((await client.getOrCreateReport(id)).parameterCoverage, [coverage]);
  for (const status of ['met', 'partial', 'not-met', 'unassessed']) {
    body = { ...report, parameterCoverage: [{ ...coverage, status, evidenceSequences: status === 'unassessed' ? [] : [1, 2] }] };
    assert.equal((await client.getOrCreateReport(id)).parameterCoverage[0].status, status);
  }
  for (const entries of [null, [coverage, coverage], Array(21).fill(coverage), [{ ...coverage, extra: true }], [{ ...coverage, status: 'failed' }], [{ ...coverage, status: ['met'] }], [{ ...coverage, requirement: 'x'.repeat(501) }], [{ ...coverage, explanation: 'x'.repeat(501) }], [{ ...coverage, parameterId: 'bad' }], [{ ...coverage, evidenceSequences: [0] }], [{ ...coverage, evidenceSequences: [1, 1] }], [{ ...coverage, evidenceSequences: [1.5] }]]) {
    body = { ...report, parameterCoverage: entries };
    await assert.rejects(client.getOrCreateReport(id), { kind: 'invalid-response' });
  }
  body = { ...report, parameterCoverage: [{ ...coverage, status: 'met', evidenceSequences: [257] }] };
  assert.deepEqual((await client.getOrCreateReport(id)).parameterCoverage[0].evidenceSequences, [257], 'the report cannot prove a completed turn index upper bound');
  body = { ...report, parameterCoverage: [{ ...coverage, explanation: '' }] };
  await assert.rejects(client.getOrCreateReport(id), { kind: 'invalid-response' });
  body = report;
  assert.deepEqual((await client.getOrCreateReport(id)).parameterCoverage, []);
});
test('admin account DTOs, duplicate guidance and form restrictions are strict', async () => {
  const { AdminAccountsClient } = require('../src/features/admin/admin-client.ts');
  const approval = { id, name: 'New Teacher', email: 'new@example.com', role: 'teacher', createdAt: date };
  let response = json(approval, 201);
  const { auth, calls } = transport(() => response, { ...profile, role: 'admin' });
  const client = new AdminAccountsClient(auth);
  const input = { name: 'New Teacher', email: 'new@example.com', password: 'exact password ', role: 'teacher' };
  assert.deepEqual(await client.createAccount(input), approval);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), input);
  response = json({ accounts: [approval] });
  assert.deepEqual(await client.listAccounts(), [approval]);
  const before = calls.length;
  for (const invalid of [{ ...input, role: 'admin' }, { ...input, email: 'bad' }, { ...input, extra: true }, { ...input, name: ' ' }, { ...input, name: 'x'.repeat(121) }, { ...input, password: 'short' }, { ...input, password: 'x'.repeat(129) }]) await assert.rejects(client.createAccount(invalid), { kind: 'invalid-input' });
  assert.equal(calls.length, before);
  response = json({}, 409);
  await assert.rejects(client.createAccount({ ...input, role: 'student' }), /already exists/);
  for (const invalid of [{ ...approval, role: 'unknown' }, { ...approval, role: ['teacher'] }, { ...approval, linked: 'false' }, { ...approval, extra: true }]) {
    response = json({ accounts: [invalid] });
    await assert.rejects(client.listAccounts(), { kind: 'invalid-response' });
  }
});
test('teacher creation validates form bounds and catalogue DTOs before displaying them', async () => {
  let body = practice;
  const { client, calls } = transport(() => json(body), { ...profile, role: 'teacher' });
  const input = { title: practice.title, setup: { level: setup.level, durationMinutes: setup.durationMinutes }, parameters: [{ requirement: 'Ask for directions' }] };
  assert.deepEqual(await client.createPractice(input), { ...practice, setup: { ...setup, difficulty: null } });
  assert.equal(calls.at(-1).url, '/api/language-practice/practices');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), input);
  const before = calls.length;
  for (const invalid of [{ ...input, title: '' }, { ...input, title: 'x'.repeat(121) }, { ...input, parameters: [] }, { ...input, parameters: Array(21).fill({ requirement: 'Ask' }) }, { ...input, parameters: [{ requirement: 'x'.repeat(501) }] }, { ...input, parameters: [{ requirement: 'Ask', id }] }, { ...input, setup: { ...input.setup, level: 'C3' } }, { ...input, setup: { ...input.setup, extra: true } }]) await assert.rejects(client.createPractice(invalid), { kind: 'invalid-input' });
  assert.equal(calls.length, before);
  for (const invalid of [{ ...practice, parameters: [practice.parameters[0], practice.parameters[0]] }, { ...practice, teacherId: 'bad' }, { ...practice, extra: true }, { ...practice, setup: { ...setup, durationMinutes: 20 } }]) {
    body = invalid;
    await assert.rejects(client.getPractice(id), { kind: 'invalid-response' });
  }
});
test('proxy target is environment-configurable with the backwards-compatible default', () => {
  const config = fs.readFileSync(require.resolve('../vite.config.ts'), 'utf8');
  assert.match(config, /target: process\.env\.LINGUALOOP_API_PROXY_TARGET \|\| 'http:\/\/localhost:5000'/);
});
test('custom sessions preserve strict response shape and classify validation/forbidden/not-found without replay', async () => {
  let body = { ...session, practiceId: id };
  let status = 200;
  const { client, calls } = transport(() => json(body, status));
  await assert.rejects(client.createCustomSession({ practiceId: id }), { kind: 'invalid-response' });
  for (const [code, kind] of [[400, 'invalid-input'], [403, 'forbidden'], [404, 'not-found'], [409, 'conflict']]) {
    status = code; body = { diagnostic: 'must not escape' };
    await assert.rejects(client.createCustomSession({ practiceId: id }), error => error.kind === kind && error.status === code && !error.message.includes('diagnostic'));
  }
  assert.equal(calls.filter(c => c.url.endsWith('/sessions')).length, 5);
  assert.equal(calls.filter(c => c.url.endsWith('/refresh')).length, 1);
});
test('403 transport is not refreshed and admin POST is exact allowlisted only', async () => {
  const { auth, client, calls } = transport(() => json({}, 403));
  await assert.rejects(client.listPractices(), { kind: 'forbidden', status: 403 });
  assert.equal((await auth.postAdminAccounts('/api/admin/accounts', { email: 'new@example.com', role: 'student' })).status, 403);
  for (const path of ['/api/admin/accounts?x=1', '/api/admin/accounts/../other', 'https://example.com/api/admin/accounts', '/api/auth/logout']) assert.equal(await auth.postAdminAccounts(path, {}), null);
  assert.equal(calls.filter(c => c.url.endsWith('/refresh')).length, 1);
});
