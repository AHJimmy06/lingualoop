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
const { LanguagePracticeClient, LanguagePracticeClientError } = require('../src/features/language-practice/language-practice-client.ts');
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const clientTurnId = '123e4567-e89b-42d3-a456-426614174001';
const turnId = '123e4567-e89b-42d3-a456-426614174002';
const sessionBody = {
  id: sessionId, status: 'ACTIVE', level: 'B1', topic: 'travel', durationMinutes: 5,
  startedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z',
  remainingMs: 300000, turnInProgress: false, turns: [],
};
const turnBody = {
  id: turnId, clientTurnId, sequence: 1, status: 'COMPLETED', transcript: 'hello',
  assistantResponse: 'Welcome.', completedAt: '2026-01-01T00:01:00.000Z',
  audioBase64: 'UklGRg==', audioMimeType: 'audio/wav', session: sessionBody,
};
const reportBody = {
  sessionId, summary: 'A bounded deterministic report.', corrections: [], strengths: ['Clear response.'],
  recommendations: ['Practice again.'], generatedWithAi: false, createdAt: '2026-01-01T00:06:00.000Z',
};

function authenticatedFetch(handler) {
  const calls = [];
  const request = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/auth/refresh') return json({ accessToken: `volatile-${calls.filter((call) => call.url === url).length}` });
    return handler(url, init, calls);
  };
  const auth = new AuthSession(request);
  return { auth, calls };
}

test('uses exact authenticated same-origin paths for setup, owned detail, and deterministic report', async () => {
  const { auth, calls } = authenticatedFetch((url) => {
    if (url === '/api/language-practice/sessions') return json(sessionBody);
    if (url === `/api/language-practice/sessions/${sessionId}`) return json(sessionBody);
    if (url === `/api/language-practice/sessions/${sessionId}/report`) return json(reportBody);
    throw new Error(`Unexpected request: ${url}`);
  });
  const client = new LanguagePracticeClient(auth);
  assert.deepEqual(await client.createSession({ level: 'B1', topic: 'travel', durationMinutes: 5 }), sessionBody);
  assert.deepEqual(await client.getSession(sessionId), sessionBody);
  assert.deepEqual(await client.getOrCreateReport(sessionId), reportBody);
  const requests = calls.filter((call) => call.url.startsWith('/api/language-practice/'));
  assert.deepEqual(requests.map((call) => call.url), [
    '/api/language-practice/sessions',
    `/api/language-practice/sessions/${sessionId}`,
    `/api/language-practice/sessions/${sessionId}/report`,
  ]);
  assert.deepEqual(requests.map((call) => call.init.method), ['POST', 'GET', 'POST']);
  for (const call of requests) {
    assert.equal(call.init.credentials, 'same-origin');
    assert.match(call.init.headers.Authorization, /^Bearer volatile-/);
  }
  assert.deepEqual(JSON.parse(requests[0].init.body), { level: 'B1', topic: 'travel', durationMinutes: 5 });
  assert.deepEqual(JSON.parse(requests[2].init.body), {});
  assert.equal(requests.length, 3, 'report request must not trigger separate paid inference calls');
});

test('submits multipart audio and preserves the caller UUID and FormData across a single 401 refresh', async () => {
  let turnRequests = 0;
  const { auth, calls } = authenticatedFetch((url, init) => {
    if (!url.endsWith('/turns')) throw new Error(`Unexpected request: ${url}`);
    turnRequests++;
    if (turnRequests === 1) return json({ diagnostic: 'must not escape' }, 401);
    return json(turnBody);
  });
  const client = new LanguagePracticeClient(auth);
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
  const result = await client.submitTurn(sessionId, audio, clientTurnId);
  assert.equal(result.clientTurnId, clientTurnId);
  const requests = calls.filter((call) => call.url.endsWith('/turns'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `/api/language-practice/sessions/${sessionId}/turns`);
  assert.strictEqual(requests[0].init.body, requests[1].init.body);
  assert.equal(requests[0].init.body.get('clientTurnId'), clientTurnId);
  assert.equal(requests[1].init.body.get('audio').type, 'audio/wav');
  assert.equal(requests[0].init.headers['Content-Type'], undefined, 'browser must set multipart boundary');
  assert.notEqual(requests[0].init.headers.Authorization, requests[1].init.headers.Authorization);
  assert.equal(requests[1].init.credentials, 'same-origin');
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.equal(calls.filter((call) => call.url === '/api/auth/refresh').length, 2);
});

test('does not retry a language-practice POST after network failure, 409, or 503', async () => {
  for (const failure of ['network', 409, 503]) {
    let posts = 0;
    const { auth, calls } = authenticatedFetch(() => {
      posts++;
      if (failure === 'network') throw new Error('sensitive transport detail');
      return json({ diagnostic: 'private server detail' }, failure);
    });
    const client = new LanguagePracticeClient(auth);
    await assert.rejects(client.getOrCreateReport(sessionId), (error) => {
      assert.ok(error instanceof LanguagePracticeClientError);
      assert.equal(error.status, failure === 'network' ? null : failure);
      assert.doesNotMatch(error.message, /sensitive|private/);
      return true;
    });
    assert.equal(posts, 1);
    assert.equal(calls.filter((call) => call.url === '/api/auth/refresh').length, 1);
  }
});

test('does not replay turn admission conflicts or retry a returned FAILED turn', async () => {
  let posts = 0;
  const conflictSession = authenticatedFetch(() => {
    posts++;
    return json({ diagnostic: 'turn admission detail' }, 409);
  });
  const conflictClient = new LanguagePracticeClient(conflictSession.auth);
  await assert.rejects(
    conflictClient.submitTurn(sessionId, new Blob(['x'], { type: 'audio/wav' }), clientTurnId),
    (error) => error.kind === 'conflict' && error.status === 409 && !error.message.includes('diagnostic'),
  );
  assert.equal(posts, 1);

  posts = 0;
  const failedTurn = { ...turnBody, status: 'FAILED', transcript: null, assistantResponse: null, completedAt: null, audioBase64: null, audioMimeType: null };
  const failedSession = authenticatedFetch(() => {
    posts++;
    return json(failedTurn);
  });
  const failedClient = new LanguagePracticeClient(failedSession.auth);
  const result = await failedClient.submitTurn(sessionId, new Blob(['x'], { type: 'audio/wav' }), clientTurnId);
  assert.equal(result.status, 'FAILED');
  assert.equal(posts, 1);
  assert.equal(failedSession.calls.filter((call) => call.url === '/api/auth/refresh').length, 1);
});

test('rejects malformed DTOs, mismatched turn ids, and response audio above 8 MiB', async () => {
  let responseBody = { ...turnBody, clientTurnId: '123e4567-e89b-42d3-a456-426614174099' };
  const { auth } = authenticatedFetch(() => json(responseBody));
  const client = new LanguagePracticeClient(auth);
  const audio = new Blob([new Uint8Array([1])], { type: 'audio/wav' });
  await assert.rejects(client.submitTurn(sessionId, audio, clientTurnId), { kind: 'invalid-response' });

  responseBody = { ...turnBody, audioBase64: 'A'.repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4) };
  await assert.rejects(client.submitTurn(sessionId, audio, clientTurnId), { kind: 'invalid-response' });
});

test('uses a bounded 240-second timeout only for multipart turns and honors response-specific text bounds', async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timeouts = [];
  let turnResponse = { ...turnBody, transcript: 't'.repeat(4000) };
  let sessionDetail = sessionBody;
  const { auth } = authenticatedFetch((url) => {
    if (url === '/api/language-practice/sessions') return json(sessionBody);
    if (url === `/api/language-practice/sessions/${sessionId}`) return json(sessionDetail);
    if (url.endsWith('/report')) return json(reportBody);
    if (url.endsWith('/turns')) return json(turnResponse);
    throw new Error(`Unexpected request: ${url}`);
  });
  await auth.refresh();
  global.setTimeout = (callback, delay) => {
    timeouts.push(delay);
    return { callback, delay };
  };
  global.clearTimeout = () => {};
  try {
    const client = new LanguagePracticeClient(auth);
    await client.createSession({ level: 'B1', topic: 'travel', durationMinutes: 5 });
    await client.getOrCreateReport(sessionId);
    const audio = new Blob(['x'], { type: 'audio/wav' });
    assert.equal((await client.submitTurn(sessionId, audio, clientTurnId)).transcript.length, 4000);
    assert.deepEqual(timeouts, [90_000, 90_000, 240_000]);

    turnResponse = { ...turnBody, transcript: 't'.repeat(4001) };
    await assert.rejects(client.submitTurn(sessionId, audio, clientTurnId), { kind: 'invalid-response' });

    const boundedHistory = {
      ...sessionBody,
      turns: [{ sequence: 1, transcript: 't'.repeat(2000), assistantResponse: 'a'.repeat(2000), completedAt: '2026-01-01T00:01:00.000Z' }],
    };
    sessionDetail = boundedHistory;
    assert.equal((await client.getSession(sessionId)).turns[0].transcript.length, 2000);
    boundedHistory.turns[0].transcript += 't';
    sessionDetail = boundedHistory;
    await assert.rejects(client.getSession(sessionId), { kind: 'invalid-response' });
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('rejects invalid input before any network request and constrains POST paths', async () => {
  const { auth, calls } = authenticatedFetch(() => json(sessionBody));
  assert.equal(await auth.postLanguagePractice('/api/auth/logout', {}), null);
  assert.equal(await auth.postLanguagePractice('/api/language-practice/../auth/logout', {}), null);
  const client = new LanguagePracticeClient(auth);
  await assert.rejects(client.getSession('../not-a-uuid'), { kind: 'invalid-input' });
  await assert.rejects(client.createSession({ level: 'Z9', topic: 'travel', durationMinutes: 5 }), { kind: 'invalid-input' });
  await assert.rejects(client.submitTurn(sessionId, new Blob(['x'], { type: 'text/plain' }), clientTurnId), { kind: 'invalid-input' });
  assert.equal(calls.length, 0);
});
