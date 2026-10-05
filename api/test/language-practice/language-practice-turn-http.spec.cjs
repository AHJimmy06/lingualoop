const test = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfiguredVerifiedRequestGuard } = require('../../dist/auth/google-auth.providers.js');
const { LinguaLoopTokenService } = require('../../dist/auth/lingualoop-token.service.js');
const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../../dist/auth/auth-store.providers.js');
const { InvalidBearerTokenError } = require('../../dist/auth/verified-request.guard.js');
const { LanguagePracticeTurnController } = require('../../dist/language-practice/language-practice-turn.controller.js');
const { LANGUAGE_PRACTICE_SESSION_STORE, LANGUAGE_PRACTICE_TURN_STORE } = require('../../dist/language-practice/language-practice-session.providers.js');
const { LANGUAGE_PRACTICE_TURN_SERVICE } = require('../../dist/language-practice/language-practice-turn.providers.js');
const { LanguagePracticeTurnAdmissionError } = require('../../dist/language-practice/language-practice-turn-store.js');

const token = 'test-access-token';
const ownerId = '550e8400-e29b-41d4-a716-446655440000';
const otherOwnerId = '550e8400-e29b-41d4-a716-446655440001';
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const clientTurnId = '323e4567-e89b-42d3-a456-426614174000';
const row = {
  id: sessionId, status: 'ACTIVE', level: 'B1', topic: 'travel', durationMinutes: 10,
  startedAt: '2026-09-24T12:00:00.000Z', expiresAt: '2026-09-24T12:10:00.000Z',
  remainingMs: 600000, turnInProgress: false,
};

async function createServer(t, overrides = {}) {
  const calls = { create: [], session: [], completed: [], turns: [], diagnostics: [] };
  class TestModule {}
  Module({
    controllers: [LanguagePracticeTurnController],
    providers: [
      { provide: LANGUAGE_PRACTICE_SESSION_STORE, useValue: {
        async createSession(owner, setup) { calls.create.push({ owner, setup }); return row; },
        async getSession(owner, id) {
          calls.session.push({ owner, id });
          if (overrides.sessionFailure) throw new Error('SECRET response session sentinel');
          return owner === ownerId && id === sessionId ? row : null;
        },
      } },
      { provide: LANGUAGE_PRACTICE_TURN_STORE, useValue: { async listCompletedTurns(owner, id) {
        calls.completed.push({ owner, id }); return [{ sequence: 1, transcript: 'Hello', assistantResponse: 'Good!', completedAt: '2026-09-24T12:01:00.000Z' }];
      } } },
      { provide: LANGUAGE_PRACTICE_TURN_SERVICE, useValue: {
        reportResponseSessionFailure() { calls.diagnostics.push('response_session'); },
        async processTurn(owner, id, client, audio) {
          calls.turns.push({ owner, id, client, audio, audioAtCall: Buffer.from(audio.buffer) });
          if (overrides.processTurn) return overrides.processTurn(owner, id, client, audio);
          return { turn: { id: '423e4567-e89b-42d3-a456-426614174000', clientTurnId: client, sequence: 1,
            status: 'COMPLETED', transcript: 'Hello', assistantResponse: 'Good!', completedAt: '2026-09-24T12:01:00.000Z' }, audioWav: Buffer.from('wav') };
        },
      } },
      { provide: LinguaLoopTokenService, useValue: { async verifyBearerToken(value) {
        if (value !== token) throw new InvalidBearerTokenError();
        return { issuer: 'google', subject: 'verified-subject', sessionId };
      } } },
      { provide: LINGUALOOP_IDENTITY_STORE, useValue: { async findOwnerByIdentity() { return ownerId; } } },
      { provide: LINGUALOOP_SESSION_STORE, useValue: { async isSessionActive(owner, session) { return owner === ownerId && session === sessionId; } } },
      ConfiguredVerifiedRequestGuard,
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); });
  const address = app.getHttpServer().address();
  return { base: `http://127.0.0.1:${address.port}`, calls };
}

const authHeaders = { authorization: `Bearer ${token}` };
async function assertStatus(response, expected) {
  if (response.status !== expected) {
    const body = (await response.text()).slice(0, 300);
    assert.equal(response.status, expected, `HTTP ${response.status}; bounded response body: ${body}`);
  }
}
function multipart(audio = new Blob(['encoded audio'], { type: 'audio/webm' }), turnId = clientTurnId) {
  const form = new FormData();
  form.append('clientTurnId', turnId);
  if (audio) form.append('audio', audio, 'turn.webm');
  return form;
}

test('missing verified identity still wipes an already parsed upload', async () => {
  const buffer = Buffer.from('private audio bytes');
  const controller = new LanguagePracticeTurnController({}, {}, {
    async processTurn() { assert.fail('turn processing must not run without verified identity'); },
  });
  await assert.rejects(
    controller.createTurn(sessionId, { clientTurnId }, { buffer, mimetype: 'audio/webm' }, {}),
    (error) => error.getStatus() === 503,
  );
  assert.deepEqual(buffer, Buffer.alloc(buffer.length));
});

test('multipart turns return original turn fields and fresh owner-scoped detail, then wipe uploaded audio', async (t) => {
  const { base, calls } = await createServer(t);
  const denied = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, { method: 'POST', body: multipart() });
  assert.equal(denied.status, 401);
  assert.equal(calls.turns.length, 0, 'guard rejects before multipart controller handling');
  const response = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, { method: 'POST', headers: authHeaders, body: multipart() });
  await assertStatus(response, 201);
  assert.deepEqual(await response.json(), {
    id: '423e4567-e89b-42d3-a456-426614174000', clientTurnId, sequence: 1, status: 'COMPLETED',
    transcript: 'Hello', assistantResponse: 'Good!', completedAt: '2026-09-24T12:01:00.000Z',
    audioBase64: Buffer.from('wav').toString('base64'), audioMimeType: 'audio/wav',
    session: { ...row, turns: [{ sequence: 1, transcript: 'Hello', assistantResponse: 'Good!', completedAt: '2026-09-24T12:01:00.000Z' }] },
  });
  assert.equal(calls.turns[0].owner, ownerId);
  assert.equal(calls.turns[0].id, sessionId);
  assert.equal(calls.turns[0].audio.mimeType, 'audio/webm');
  assert.deepEqual(calls.turns[0].audio.buffer, Buffer.alloc(calls.turns[0].audioAtCall.length));
  assert.deepEqual(calls.session, [{ owner: ownerId, id: sessionId }]);
  assert.deepEqual(calls.completed, [{ owner: ownerId, id: sessionId }]);
});

test('invalid form, MIME, and admission failures do not leak diagnostics or cross owner data', async (t) => {
  const { base } = await createServer(t, { async processTurn() { throw new LanguagePracticeTurnAdmissionError('not_found'); } });
  const malformed = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, { method: 'POST', headers: authHeaders, body: multipart(null) });
  assert.equal(malformed.status, 400);
  const invalidMime = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, { method: 'POST', headers: authHeaders, body: multipart(new Blob(['no'], { type: 'text/plain' })) });
  assert.equal(invalidMime.status, 400);
  const missing = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, { method: 'POST', headers: authHeaders, body: multipart() });
  await assertStatus(missing, 404);
  assert.doesNotMatch(await missing.text(), /not_found|diagnostic/i);

  const deniedOwner = await createServer(t, { async processTurn(owner) {
    assert.equal(owner, ownerId);
    throw new LanguagePracticeTurnAdmissionError('not_found');
  } });
  const hidden = await fetch(`${deniedOwner.base}/language-practice/sessions/${sessionId}/turns`, { method: 'POST', headers: authHeaders, body: multipart() });
  await assertStatus(hidden, 404);
});

test('multipart caps reject oversized audio and extra fields/files', async (t) => {
  const { base, calls } = await createServer(t);
  const oversized = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, {
    method: 'POST', headers: authHeaders,
    body: multipart(new Blob([Buffer.alloc(2 * 1024 * 1024 + 1)], { type: 'audio/webm' })),
  });
  assert.equal(oversized.status, 413);

  const extraField = new FormData();
  extraField.append('clientTurnId', clientTurnId);
  extraField.append('unexpected', 'extra');
  extraField.append('audio', new Blob(['audio'], { type: 'audio/webm' }), 'turn.webm');
  const fieldsResponse = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, {
    method: 'POST', headers: authHeaders, body: extraField,
  });
  assert.equal(fieldsResponse.status, 400);

  const extraFile = multipart();
  extraFile.append('audio', new Blob(['second'], { type: 'audio/webm' }), 'second.webm');
  const filesResponse = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, {
    method: 'POST', headers: authHeaders, body: extraFile,
  });
  assert.equal(filesResponse.status, 400);
  assert.equal(calls.turns.length, 0, 'rejected uploads never reach turn processing');
});

test('fresh-session failures return generic 503 and emit only the fixed response stage code', async (t) => {
  const { base, calls } = await createServer(t, { sessionFailure: true });
  const response = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, { method: 'POST', headers: authHeaders, body: multipart() });
  await assertStatus(response, 503);
  const body = await response.text();
  assert.doesNotMatch(body, /SECRET|response session sentinel|diagnostic/i);
  assert.deepEqual(calls.diagnostics, ['response_session']);
});

test('replayed turns return null audio without paid inference fields', async (t) => {
  const { base } = await createServer(t, { async processTurn(owner, id, client, audio) {
    return { turn: { id: '423e4567-e89b-42d3-a456-426614174000', clientTurnId: client, sequence: 1,
      status: 'COMPLETED', transcript: 'Previously saved', assistantResponse: 'Already answered', completedAt: '2026-09-24T12:01:00.000Z' }, audioWav: null };
  } });
  const response = await fetch(`${base}/language-practice/sessions/${sessionId}/turns`, { method: 'POST', headers: authHeaders, body: multipart() });
  await assertStatus(response, 201);
  const payload = await response.json();
  assert.equal(payload.transcript, 'Previously saved');
  assert.equal(payload.audioBase64, null);
  assert.equal(payload.audioMimeType, null);
});
