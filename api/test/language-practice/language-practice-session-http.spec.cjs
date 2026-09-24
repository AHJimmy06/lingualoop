const test = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfiguredVerifiedRequestGuard } = require('../../dist/auth/google-auth.providers.js');
const { LinguaLoopTokenService } = require('../../dist/auth/lingualoop-token.service.js');
const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../../dist/auth/auth-store.providers.js');
const { InvalidBearerTokenError } = require('../../dist/auth/verified-request.guard.js');
const { LanguagePracticeSessionController } = require('../../dist/language-practice/language-practice-session.controller.js');
const { LANGUAGE_PRACTICE_SESSION_STORE } = require('../../dist/language-practice/language-practice-session.providers.js');

const token = 'test-access-token';
const ownerId = '550e8400-e29b-41d4-a716-446655440000';
const otherOwnerId = '550e8400-e29b-41d4-a716-446655440001';
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const completedTurns = [{ sequence: 1, transcript: 'I like travel.', assistantResponse: 'Great sentence.', completedAt: '2026-09-24T12:01:00.000Z' }];
const row = {
  id: sessionId, status: 'ACTIVE', level: 'B1', topic: 'travel', durationMinutes: 10,
  startedAt: '2026-09-24T12:00:00.000Z', expiresAt: '2026-09-24T12:10:00.000Z',
  remainingMs: 600000, turnInProgress: false,
};

async function createServer(t, turnStore = { async listCompletedTurns(owner, id) {
  return owner === ownerId && id === sessionId ? completedTurns : [];
} }) {
  const calls = [];
  const turnCalls = [];
  class TestModule {}
  Module({
    controllers: [LanguagePracticeSessionController],
    providers: [
      { provide: LANGUAGE_PRACTICE_SESSION_STORE, useValue: { async getSession(owner, id) {
        calls.push({ owner, id });
        return owner === ownerId && id === sessionId ? row : null;
      } } },
      { provide: require('../../dist/language-practice/language-practice-session.providers.js').LANGUAGE_PRACTICE_TURN_STORE,
        useValue: { async listCompletedTurns(owner, id) {
          turnCalls.push({ owner, id });
          return turnStore.listCompletedTurns(owner, id);
        } } },
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
  return { base: `http://127.0.0.1:${address.port}`, calls, turnCalls };
}

const authHeaders = { authorization: `Bearer ${token}` };

test('options are protected and preserve the original catalog labels and limits', async (t) => {
  const { base } = await createServer(t);
  const denied = await fetch(`${base}/language-practice/options`);
  assert.equal(denied.status, 401);
  const response = await fetch(`${base}/language-practice/options`, { headers: authHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    levels: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],
    durationsMinutes: [5, 10, 15],
    inputLanguage: { code: 'en', label: 'English' },
    outputLanguages: [{ code: 'en', label: 'English' }, { code: 'es', label: 'Spanish' }],
    topics: [
      { code: 'travel', label: 'Travel' }, { code: 'work', label: 'Work' },
      { code: 'studies', label: 'Studies' },
      { code: 'everyday-conversation', label: 'Everyday conversation' },
    ],
    acceptedMimeTypes: ['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus', 'audio/wav', 'audio/x-wav', 'audio/mp4'],
    maxFileSizeBytes: 2097152,
    maxDurationMs: 20000,
  });
});

test('session detail is protected and returns owner-scoped completed turns', async (t) => {
  const { base, calls, turnCalls } = await createServer(t);
  const denied = await fetch(`${base}/language-practice/sessions/${sessionId}`);
  assert.equal(denied.status, 401);
  const response = await fetch(`${base}/language-practice/sessions/${sessionId}`, { headers: authHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...row, turns: completedTurns });
  assert.deepEqual(calls, [{ owner: ownerId, id: sessionId }]);
  assert.deepEqual(turnCalls, [{ owner: ownerId, id: sessionId }]);
  const missing = await fetch(`${base}/language-practice/sessions/123e4567-e89b-42d3-a456-426614174001`, { headers: authHeaders });
  assert.equal(missing.status, 404);
  assert.equal(turnCalls.length, 1, 'turn listing is not called before the owned session lookup succeeds');
  const malformed = await fetch(`${base}/language-practice/sessions/not-a-uuid`, { headers: authHeaders });
  assert.equal(malformed.status, 400);
});

test('completed turn store failures return a generic unavailable response', async (t) => {
  const { base } = await createServer(t, { async listCompletedTurns() { throw new Error('private database detail'); } });
  const response = await fetch(`${base}/language-practice/sessions/${sessionId}`, { headers: authHeaders });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { statusCode: 503, message: 'Language practice session is unavailable.' });
});
