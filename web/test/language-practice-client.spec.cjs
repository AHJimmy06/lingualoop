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
const { parseReportLearningSupport } = require('../src/features/language-practice/language-practice-client.ts');

const learningSupportBody = {
  corrections: [{ sequence: 1, suggestedEnglish: 'I would like to visit Peru.', translationEs: 'Me gustaría visitar Perú.', explanationEn: 'Use visit for a destination.', explanationEs: 'Usa visit para un destino.' }],
  strengths: [{ textEn: 'You named a destination.', textEs: 'Mencionaste un destino.', evidenceSequences: [1] }],
  recommendations: [{ textEn: 'Practise describing your travel plans.', textEs: 'Practica describir tus planes de viaje.', evidenceSequences: [1] }],
};

test('learning support validates bilingual content and rejects duplicate or malformed evidence', () => {
  assert.deepEqual(parseReportLearningSupport(learningSupportBody), learningSupportBody);
  for (const invalid of [
    { ...learningSupportBody, extra: true },
    { ...learningSupportBody, corrections: [...learningSupportBody.corrections, ...learningSupportBody.corrections] },
    { ...learningSupportBody, corrections: [{ ...learningSupportBody.corrections[0], suggestedEnglish: 'x'.repeat(501) }] },
    { ...learningSupportBody, strengths: [{ ...learningSupportBody.strengths[0], evidenceSequences: [1, 1] }] },
    { ...learningSupportBody, recommendations: [{ ...learningSupportBody.recommendations[0], evidenceSequences: [0] }] },
  ]) assert.throws(() => parseReportLearningSupport(invalid), LanguagePracticeClientError);
});
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
  sessionId, parameterCoverage: [], summary: 'A bounded deterministic report.', corrections: [], strengths: ['Clear response.'],
  recommendations: ['Practice again.'], generatedWithAi: false, createdAt: '2026-01-01T00:06:00.000Z',
};

function authenticatedFetch(handler) {
  const calls = [];
  const request = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/auth/refresh') return json({ accessToken: `volatile-${calls.filter((call) => call.url === url).length}` });
    if (url === '/api/auth/me') return json({ ownerId: sessionId, name: 'Student', email: 'student@example.com', role: 'student' });
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
  assert.deepEqual(await client.createSession({ level: 'B1', topic: 'travel', durationMinutes: 5 }), { ...sessionBody, difficulty: null });
  assert.deepEqual(await client.getSession(sessionId), { ...sessionBody, difficulty: null });
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

test('session and nested turn difficulty accept nullable snapshots and normalize legacy omission', async () => {
  let dto = sessionBody;
  const { auth } = authenticatedFetch(url => json(url.endsWith('/turns') ? { ...turnBody, session: dto } : dto));
  const client = new LanguagePracticeClient(auth);
  const audio = new Blob(['x'], { type: 'audio/wav' });
  assert.equal((await client.getSession(sessionId)).difficulty, null);
  assert.equal((await client.submitTurn(sessionId, audio, clientTurnId)).session.difficulty, null);
  assert.equal((await client.createCustomSession({ practiceId: sessionId })).difficulty, null);
  for (const difficulty of [null, 'easy', 'medium', 'hard']) {
    dto = { ...sessionBody, difficulty };
    assert.deepEqual(await client.getSession(sessionId), dto);
    assert.equal((await client.submitTurn(sessionId, audio, clientTurnId)).session.difficulty, difficulty);
    assert.equal((await client.createCustomSession({ practiceId: sessionId })).difficulty, difficulty);
  }
  for (const difficulty of ['', 'expert', 'HARD', 1, false, [], {}]) {
    dto = { ...sessionBody, difficulty };
    await assert.rejects(client.getSession(sessionId), { kind: 'invalid-response' });
    await assert.rejects(client.submitTurn(sessionId, audio, clientTurnId), { kind: 'invalid-response' });
  }
  dto = { ...sessionBody, difficulty: 'easy', unrelated: true };
  await assert.rejects(client.getSession(sessionId), { kind: 'invalid-response' });
});

test('session request difficulty is optional non-null and forwarded without changing CEFR or duration', async () => {
  const { auth, calls } = authenticatedFetch(() => json({ ...sessionBody, difficulty: 'hard' }));
  const client = new LanguagePracticeClient(auth);
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const setup = { level: 'A1', topic: 'travel', durationMinutes: 15, difficulty };
    assert.equal((await client.createSession(setup)).difficulty, 'hard', 'response snapshot is authoritative');
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), setup);
  }
  const count = calls.length;
  for (const difficulty of [null, undefined, '', 'expert', 1, false, [], {}]) {
    await assert.rejects(client.createSession({ level: 'B1', topic: 'travel', durationMinutes: 5, difficulty }), { kind: 'invalid-input' });
  }
  for (const override of [{ unrelated: true }, { level: 'Z9' }, { durationMinutes: 20 }]) {
    await assert.rejects(client.createSession({ level: 'B1', topic: 'travel', durationMinutes: 5, difficulty: 'easy', ...override }), { kind: 'invalid-input' });
  }
  assert.equal(calls.length, count);
});

test('accepts either exact report provenance boolean and rejects missing or non-boolean provenance', async () => {
  let responseBody = { ...reportBody, generatedWithAi: true };
  const { auth } = authenticatedFetch(() => json(responseBody));
  const client = new LanguagePracticeClient(auth);
  assert.equal((await client.getOrCreateReport(sessionId)).generatedWithAi, true);

  responseBody = { ...reportBody, generatedWithAi: false };
  assert.equal((await client.getOrCreateReport(sessionId)).generatedWithAi, false);

  for (const invalid of [
    { ...reportBody, generatedWithAi: 'true' },
    { ...reportBody, generatedWithAi: 1 },
    { ...reportBody, generatedWithAi: null },
    Object.fromEntries(Object.entries(reportBody).filter(([key]) => key !== 'generatedWithAi')),
  ]) {
    responseBody = invalid;
    await assert.rejects(client.getOrCreateReport(sessionId), { kind: 'invalid-response' });
  }
});

test('finishes a session through authenticated POST and validates the exact completion response', async () => {
  const { auth, calls } = authenticatedFetch((url) => {
    assert.equal(url, `/api/language-practice/sessions/${sessionId}/finish`);
    return json({ id: sessionId, status: 'COMPLETED' });
  });
  const client = new LanguagePracticeClient(auth);
  assert.deepEqual(await client.finishSession(sessionId), { id: sessionId, status: 'COMPLETED' });
  const request = calls.find((call) => call.url.includes('/finish'));
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.credentials, 'same-origin');
  assert.match(request.init.headers.Authorization, /^Bearer volatile-/);
  assert.deepEqual(JSON.parse(request.init.body), {});
});

test('finish validates session identity and status and does not retry conflicts or unavailable responses', async () => {
  for (const body of [
    { id: clientTurnId, status: 'COMPLETED' },
    { id: sessionId, status: 'ACTIVE' },
    { id: sessionId, status: 'EXPIRED', extra: true },
  ]) {
    const { auth } = authenticatedFetch(() => json(body));
    await assert.rejects(new LanguagePracticeClient(auth).finishSession(sessionId), { kind: 'invalid-response' });
  }
  for (const failure of [409, 503]) {
    let posts = 0;
    const { auth } = authenticatedFetch(() => { posts++; return json({}, failure); });
    await assert.rejects(new LanguagePracticeClient(auth).finishSession(sessionId), (error) => error.status === failure);
    assert.equal(posts, 1);
  }
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

test('deduplicates concurrent report loads across client instances', async () => {
  let finishResponse;
  let posts = 0;
  const first = authenticatedFetch(() => {
    posts++;
    return new Promise(resolve => { finishResponse = resolve; });
  });
  const second = authenticatedFetch(() => {
    posts++;
    return json(reportBody);
  });
  const firstRequest = new LanguagePracticeClient(first.auth).getOrCreateReport(sessionId);
  const secondRequest = new LanguagePracticeClient(second.auth).getOrCreateReport(sessionId);
  assert.strictEqual(secondRequest, firstRequest);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts, 1);
  finishResponse(json(reportBody));
  assert.deepEqual(await Promise.all([firstRequest, secondRequest]), [reportBody, reportBody]);
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

const practiceInput = { title: 'Ordering sushi', setup: { level: 'B1', durationMinutes: 5 }, parameters: [{ requirement: 'Order a meal' }] };
const practiceDto = { ...practiceInput, setup: { ...practiceInput.setup, topic: 'everyday-conversation' }, id: sessionId, teacherId: sessionId, teacherName: 'Teacher', hasImage: true, createdAt: '2026-01-01T00:00:00.000Z', parameters: [{ id: turnId, requirement: 'Order a meal' }] };

test('practice creation uses strict JSON or multipart metadata and refreshes without setting a multipart content type', async () => {
  let retry = true;
  const { auth, calls } = authenticatedFetch((url, init) => {
    assert.equal(url, '/api/language-practice/practices');
    if (init.body instanceof FormData && retry) { retry = false; return json({}, 401); }
    return json(practiceDto, 201);
  });
  const client = new LanguagePracticeClient(auth);
  assert.deepEqual(await client.createPractice(practiceInput), { ...practiceDto, setup: { ...practiceDto.setup, difficulty: null } });
  const image = new Blob(['png'], { type: 'image/png' });
  assert.deepEqual(await client.createPractice(practiceInput, image), { ...practiceDto, setup: { ...practiceDto.setup, difficulty: null } });
  const posts = calls.filter(call => call.url.endsWith('/practices'));
  assert.deepEqual(JSON.parse(posts[0].init.body), practiceInput);
  assert.equal(posts[0].init.headers['Content-Type'], 'application/json');
  for (const call of posts.slice(1)) {
    assert.deepEqual([...call.init.body.keys()], ['metadata', 'image']);
    assert.deepEqual(JSON.parse(call.init.body.get('metadata')), practiceInput);
    assert.equal(call.init.body.get('image').type, 'image/png');
    assert.equal(call.init.headers['Content-Type'], undefined);
    assert.equal(call.init.credentials, 'same-origin');
    assert.match(call.init.headers.Authorization, /^Bearer volatile-/);
  }
  assert.equal(posts.length, 3);
  const count = calls.length;
  for (const image of [new Blob([], { type: 'image/jpeg' }), new Blob(['x'], { type: 'image/svg+xml' }), new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/webp' })]) await assert.rejects(client.createPractice(practiceInput, image), { kind: 'invalid-input' });
  assert.equal(calls.length, count);
});

test('image binary retrieval reuses authenticated refresh, exact local path and bounded JPEG contract', async () => {
  let status = 401;
  let mime = 'image/jpeg';
  const { auth, calls } = authenticatedFetch(url => {
    assert.equal(url, `/api/language-practice/practices/${sessionId}/image`);
    if (status === 401) { status = 200; return json({}, 401); }
    return new Response(new Uint8Array([255, 216, 255, 217]), { status, headers: { 'content-type': mime } });
  });
  const client = new LanguagePracticeClient(auth);
  assert.equal((await client.getPracticeImage(sessionId)).type, 'image/jpeg');
  for (const call of calls.filter(call => call.url.endsWith('/image'))) {
    assert.equal(call.init.credentials, 'same-origin');
    assert.match(call.init.headers.Authorization, /^Bearer volatile-/);
    assert.equal(call.init.method, 'GET');
    assert.ok(!call.url.includes('?'));
  }
  for (const [code, kind] of [[403, 'forbidden'], [404, 'not-found'], [503, 'unavailable']]) {
    status = code; await assert.rejects(client.getPracticeImage(sessionId), { kind });
  }
  status = 200; mime = 'image/svg+xml';
  await assert.rejects(client.getPracticeImage(sessionId), { kind: 'invalid-response' });
  await assert.rejects(client.getPracticeImage('../bad'), { kind: 'invalid-input' });
  auth.clearLocal();
  await assert.rejects(client.getPracticeImage(sessionId), { kind: 'unauthenticated' });
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

test('learning support uses read-only cache lookup and deduplicates explicit generation across clients', async () => {
  let cached = false;
  const path = `/api/language-practice/sessions/${sessionId}/report/learning-support`;
  const { auth, calls } = authenticatedFetch((url, init) => {
    assert.equal(url, path);
    if (init.method === 'GET') return cached ? json(learningSupportBody) : new Response(null, { status: 204 });
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), {});
    cached = true;
    return json(learningSupportBody);
  });
  const first = new LanguagePracticeClient(auth);
  const second = new LanguagePracticeClient(auth);
  assert.equal(await first.getCachedReportLearningSupport(sessionId), null);
  assert.equal(calls.filter(call => call.url === path && call.init.method === 'POST').length, 0);
  const request = first.prepareReportLearningSupport(sessionId);
  assert.equal(second.prepareReportLearningSupport(sessionId), request);
  assert.deepEqual(await request, learningSupportBody);
  assert.equal(calls.filter(call => call.url === path && call.init.method === 'POST').length, 1);
  assert.deepEqual(await second.getCachedReportLearningSupport(sessionId), learningSupportBody);
});

test('complete report waits for automatic bilingual generation and reuses cached support', async () => {
  const closed = { ...sessionBody, status: 'COMPLETED', remainingMs: 0,
    turns: [{ sequence: 1, transcript: 'I go yesterday.', assistantResponse: 'Where?', completedAt: '2026-01-01T00:01:00.000Z' }] };
  let cached = false, release, settled = false;
  const { auth, calls } = authenticatedFetch((url, init) => {
    if (url.endsWith('/report')) return json(reportBody);
    if (url.endsWith('/learning-support') && init.method === 'GET') return cached ? json(learningSupportBody) : new Response(null, { status: 204 });
    if (url.endsWith('/learning-support')) return new Promise(resolve => { release = () => { cached = true; resolve(json(learningSupportBody)); }; });
    if (url.endsWith(sessionId)) return json(closed);
    throw Error('Unexpected route');
  });
  const client = new LanguagePracticeClient(auth);
  const pending = client.getCompleteReport(sessionId).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'base report must not be returned before enrichment is ready');
  assert.equal(typeof release, 'function');
  release();
  const result = await pending;
  assert.deepEqual(result.report, reportBody);
  assert.deepEqual(result.learningSupport, learningSupportBody);
  const again = await client.getCompleteReport(sessionId);
  assert.deepEqual(again.learningSupport, learningSupportBody);
  assert.equal(calls.filter(c => c.url.endsWith('/learning-support') && c.init.method === 'POST').length, 1);
});

test('support failure rejects the whole report and full retry completes without new recording', async () => {
  const closed = { ...sessionBody, status: 'COMPLETED', remainingMs: 0,
    turns: [{ sequence: 1, transcript: 'Hello', assistantResponse: 'Hi', completedAt: '2026-01-01T00:01:00.000Z' }] };
  let fail = true;
  const { auth } = authenticatedFetch((url, init) => {
    if (url.endsWith('/report')) return json(reportBody);
    if (url.endsWith('/learning-support') && init.method === 'GET') return new Response(null, { status: 204 });
    if (url.endsWith('/learning-support')) return fail ? json({}, 503) : json(learningSupportBody);
    return json(closed);
  });
  const client = new LanguagePracticeClient(auth);
  await assert.rejects(client.getCompleteReport(sessionId), { kind: 'unavailable' });
  fail = false;
  assert.deepEqual((await client.getCompleteReport(sessionId)).learningSupport, learningSupportBody);
});

test('complete report for an empty session needs no optional AI enrichment', async () => {
  const { auth, calls } = authenticatedFetch(url => url.endsWith('/report') ? json(reportBody) : json({ ...sessionBody, status: 'EXPIRED', remainingMs: 0 }));
  const complete = await new LanguagePracticeClient(auth).getCompleteReport(sessionId);
  assert.deepEqual(complete.learningSupport, { corrections: [], strengths: [], recommendations: [] });
  assert.equal(calls.some(c => c.url.includes('learning-support')), false);
});
