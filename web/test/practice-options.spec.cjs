const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { AuthSession } = require('../src/auth-session.ts');
const { fetchPracticeOptions, parsePracticeOptions } = require('../src/features/language-practice/practice-options.ts');

const payload = {
  levels: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], durationsMinutes: [5, 10, 15],
  inputLanguage: { code: 'en', label: 'English' },
  outputLanguages: [{ code: 'en', label: 'English' }, { code: 'es', label: 'Spanish' }],
  topics: [
    { code: 'travel', label: 'Travel' }, { code: 'work', label: 'Work' },
    { code: 'studies', label: 'Studies' },
    { code: 'everyday-conversation', label: 'Everyday conversation' },
  ],
  acceptedMimeTypes: [
    'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus',
    'audio/wav', 'audio/x-wav', 'audio/mp4',
  ],
  maxFileSizeBytes: 2097152, maxDurationMs: 20000,
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function validOptions() {
  return parsePracticeOptions(payload);
}

test('accepts and preserves the exact original supported catalog', () => {
  assert.deepEqual(validOptions(), payload);
});

test('rejects catalogs outside original values and malformed server options', () => {
  assert.equal(parsePracticeOptions(null), null);
  assert.equal(parsePracticeOptions({ ...payload, levels: ['A1', '', 'B1', 'B2', 'C1', 'C2'] }), null);
  assert.equal(parsePracticeOptions({ ...payload, levels: ['A1', 'A1', 'B1', 'B2', 'C1', 'C2'] }), null);
  assert.equal(parsePracticeOptions({ ...payload, levels: ['A1', 'A2', 'B1', 'B2', 'C1', 'C3'] }), null);
  assert.equal(parsePracticeOptions({ ...payload, durationsMinutes: [5, 10.5, 15] }), null);
  assert.equal(parsePracticeOptions({ ...payload, durationsMinutes: [5, 5, 15] }), null);
  assert.equal(parsePracticeOptions({ ...payload, topics: payload.topics.slice(0, 3) }), null);
  assert.equal(parsePracticeOptions({ ...payload, topics: [{ ...payload.topics[0], code: 'other' }, ...payload.topics.slice(1)] }), null);
  assert.equal(parsePracticeOptions({ ...payload, inputLanguage: { code: 'es', label: 'Spanish' } }), null);
  assert.equal(parsePracticeOptions({ ...payload, outputLanguages: [{ code: 'fr', label: 'French' }] }), null);
  assert.equal(parsePracticeOptions({ ...payload, outputLanguages: [{ code: 'en', label: 'English' }, { code: 'en', label: 'Other' }] }), null);
  assert.equal(parsePracticeOptions({ ...payload, topics: [{ code: 'travel', label: 'Travel' }, { code: 'travel', label: 'Other' }, ...payload.topics.slice(2)] }), null);
  assert.equal(parsePracticeOptions({ ...payload, topics: [{ code: 'travel', label: 'Travel' }, { code: 'work', label: ' travel ' }, ...payload.topics.slice(2)] }), null);
  assert.equal(parsePracticeOptions({ ...payload, topics: [{ code: ' ', label: 'Travel' }, ...payload.topics.slice(1)] }), null);
  assert.equal(parsePracticeOptions({ ...payload, outputLanguages: [{ code: 'en', label: '  ' }, payload.outputLanguages[1]] }), null);
  assert.equal(parsePracticeOptions({ ...payload, acceptedMimeTypes: [] }), null);
  assert.equal(parsePracticeOptions({ ...payload, acceptedMimeTypes: ['audio/webm', ' '] }), null);
  assert.equal(parsePracticeOptions({ ...payload, acceptedMimeTypes: ['audio/webm', 'AUDIO/WEBM'] }), null);
  assert.equal(parsePracticeOptions({ ...payload, maxDurationMs: Number.NaN }), null);
});

test('requests protected options with bearer and refreshes exactly once after 401', async () => {
  const calls = [];
  const session = new AuthSession(async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/auth/me') return json({ ownerId: '123e4567-e89b-42d3-a456-426614174000', name: 'Student', email: 'student@example.com', role: 'student' });
    if (url === '/api/auth/refresh') return json({ accessToken: `token-${calls.length}` });
    if (calls.filter((call) => call.url.endsWith('/options')).length === 1) return json({}, 401);
    return json(payload);
  });

  assert.deepEqual(await fetchPracticeOptions(session), payload);
  const optionCalls = calls.filter((call) => call.url.endsWith('/options'));
  assert.equal(optionCalls.length, 2);
  assert.equal(optionCalls[0].init.headers.Authorization, 'Bearer token-1');
  assert.equal(optionCalls[1].init.headers.Authorization, 'Bearer token-4');
  assert.equal(optionCalls[1].init.credentials, 'same-origin');
});

test('does not retry beyond one refresh or expose an unauthenticated options response', async () => {
  let optionCalls = 0;
  let refreshCalls = 0;
  const session = new AuthSession(async (url) => {
    if (url === '/api/auth/me') return json({ ownerId: '123e4567-e89b-42d3-a456-426614174000', name: 'Student', email: 'student@example.com', role: 'student' });
    if (url === '/api/auth/refresh') {
      refreshCalls++;
      return json({ accessToken: `token-${refreshCalls}` });
    }
    optionCalls++;
    return json({}, 401);
  });

  await assert.rejects(fetchPracticeOptions(session), /currently unavailable/);
  assert.equal(optionCalls, 2);
  assert.equal(refreshCalls, 2);
});

test('a refresh resolving after confirmed logout cannot restore its bearer', async () => {
  const lateRefresh = deferred();
  let refreshCalls = 0;
  const session = new AuthSession(async (url) => {
    if (url === '/api/auth/me') return json({ ownerId: '123e4567-e89b-42d3-a456-426614174000', name: 'Student', email: 'student@example.com', role: 'student' });
    if (url === '/api/auth/refresh') {
      refreshCalls++;
      return refreshCalls === 1
        ? json({ accessToken: 'before-logout' })
        : lateRefresh.promise;
    }
    if (url === '/api/auth/logout') return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url}`);
  });

  assert.equal(await session.refresh(), 'authenticated');
  const pendingRefresh = session.refresh();
  assert.equal(await session.logout(), true);
  assert.equal(session.authenticated, false);
  lateRefresh.resolve(json({ accessToken: 'stale-after-logout' }));
  assert.equal(await pendingRefresh, 'no-session');
  assert.equal(session.authenticated, false);
});

test('a late options 401 cannot start refresh after local auth is cleared', async () => {
  const lateOptions = deferred();
  let refreshCalls = 0;
  let optionsCalls = 0;
  const session = new AuthSession(async (url) => {
    if (url === '/api/auth/me') return json({ ownerId: '123e4567-e89b-42d3-a456-426614174000', name: 'Student', email: 'student@example.com', role: 'student' });
    if (url === '/api/auth/refresh') {
      refreshCalls++;
      return json({ accessToken: 'before-clear' });
    }
    optionsCalls++;
    return lateOptions.promise;
  });

  assert.equal(await session.refresh(), 'authenticated');
  const pendingOptions = session.getWithRefresh('/api/language-practice/options');
  session.clearLocal();
  lateOptions.resolve(json({}, 401));
  assert.equal(await pendingOptions, null);
  assert.equal(await session.refresh(), 'no-session');
  assert.equal(await session.getWithRefresh('/api/language-practice/options'), null);
  assert.equal(refreshCalls, 1);
  assert.equal(optionsCalls, 1);
});

test('a new refresh after clearLocal is held without making a request', async () => {
  let calls = 0;
  const session = new AuthSession(async () => {
    calls++;
    return json({ accessToken: 'must-not-be-issued' });
  });

  session.clearLocal();
  assert.equal(await session.refresh(), 'no-session');
  assert.equal(await session.getWithRefresh('/api/language-practice/options'), null);
  assert.equal(session.authenticated, false);
  assert.equal(calls, 0);
});
