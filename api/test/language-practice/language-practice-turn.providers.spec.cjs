const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LANGUAGE_PRACTICE_TURN_COACH,
  LANGUAGE_PRACTICE_TURN_SERVICE,
  assembleLanguagePracticeTurnService,
  createLanguagePracticeTurnProviders,
  loadLanguagePracticeTurnCoachConfig,
} = require('../../dist/language-practice/language-practice-turn.providers.js');
const { LANGUAGE_PRACTICE_SESSION_STORE, LANGUAGE_PRACTICE_TURN_STORE } = require('../../dist/language-practice/language-practice-session.providers.js');
const { PracticeTurnUnavailableError } = require('../../dist/language-practice/language-practice-turn.service.js');

const ownerId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const clientTurnId = '33333333-3333-4333-8333-333333333333';
const turnId = '44444444-4444-4444-8444-444444444444';
const leaseToken = '55555555-5555-4555-8555-555555555555';
const env = {
  LINGUALOOP_OPENAI_API_KEY_FILE: '/unit-test/coach.env',
  LANGUAGE_PRACTICE_OPENAI_MODEL: 'gpt-5.6-luna',
};

function completedTurn() {
  return {
    id: turnId, clientTurnId, sequence: 1, status: 'COMPLETED', leaseToken,
    transcript: 'hello', assistantResponse: 'Good morning.',
    spanishCorrectionEvidence: '{}', completedAt: '2026-01-01T00:00:00.000Z',
  };
}

function reservation(replay) {
  return {
    replay,
    turn: replay ? completedTurn() : {
      ...completedTurn(), status: 'PROCESSING', transcript: null,
      assistantResponse: null, completedAt: null,
    },
  };
}

test('assembles a pure turn service and maps each explicit port exactly once', async () => {
  const calls = [];
  const buffer = Buffer.from('input');
  const wav = Buffer.from('wav');
  const history = [{ role: 'user', content: 'Earlier.' }];
  const service = assembleLanguagePracticeTurnService({
    turnStore: {
      reserveTurn: async (...args) => {
        calls.push(['reserveTurn', ...args]);
        return calls.filter(([name]) => name === 'reserveTurn').length === 1 ? reservation(false) : reservation(true);
      },
      completeTurn: async (...args) => { calls.push(['completeTurn', ...args]); return true; },
      failTurn: async (...args) => { calls.push(['failTurn', ...args]); return true; },
    },
    sessions: { getOwnedSession: async (...args) => { calls.push(['getOwnedSession', ...args]); return { level: 'B1', topic: 'travel' }; } },
    history: { getCompletedHistory: async (...args) => { calls.push(['getCompletedHistory', ...args]); return history; } },
    speechToText: { transcribeBounded: async (...args) => { calls.push(['transcribeBounded', ...args]); return 'hello'; } },
    synthesis: { synthesizeLocal: async (...args) => { calls.push(['synthesizeLocal', ...args]); return wav; } },
    coach: { respond: async (input) => { calls.push(['respond', input]); return { correctedPhrase: 'hola', feedback: 'bien', assistantResponse: 'Good morning.' }; } },
  });

  const result = await service.processTurn(ownerId, sessionId, clientTurnId, { buffer, mimeType: 'audio/wav' });
  assert.equal(result.audioWav, wav);
  assert.deepEqual(calls.map(([name]) => name), [
    'reserveTurn', 'getOwnedSession', 'getCompletedHistory', 'transcribeBounded',
    'respond', 'synthesizeLocal', 'completeTurn', 'reserveTurn',
  ]);
  assert.deepEqual(calls[0], ['reserveTurn', ownerId, sessionId, clientTurnId]);
  assert.deepEqual(calls[1], ['getOwnedSession', ownerId, sessionId]);
  assert.deepEqual(calls[2], ['getCompletedHistory', ownerId, sessionId]);
  assert.deepEqual(calls[3], ['transcribeBounded', buffer, 'audio/wav']);
  assert.deepEqual(calls[4][1].history, history);
  assert.deepEqual(calls[5], ['synthesizeLocal', 'Good morning.', 'en']);
  assert.deepEqual(calls[6], [
    'completeTurn', ownerId, sessionId, turnId, leaseToken, 'hello', 'Good morning.',
    JSON.stringify({ correctedPhrase: 'hola', feedback: 'bien' }),
  ]);
});

test('Nest provider assembly eagerly constructs one safe adapter and delegates owner-scoped ports', async () => {
  let constructions = 0;
  let requests = 0;
  const providers = createLanguagePracticeTurnProviders(env, {
    inspectFile: () => ({ isFile: () => true, mode: 0o100600 }),
    readFile: () => 'OPENAI_API_KEY=fake-test-value\n',
    OpenAIConstructor: class { constructor() { constructions += 1; this.responses = { create: async () => { requests += 1; throw new Error('not called'); } }; } },
  });
  const coachProvider = providers.find((provider) => provider.provide === LANGUAGE_PRACTICE_TURN_COACH);
  assert.equal(constructions, 1);
  assert.equal(requests, 0);
  assert.equal(typeof coachProvider.useValue.respond, 'function');
  const serviceProvider = providers.find((provider) => provider.provide === LANGUAGE_PRACTICE_TURN_SERVICE);
  assert.ok(coachProvider);
  assert.ok(serviceProvider);
  assert.deepEqual(serviceProvider.inject, [
    LANGUAGE_PRACTICE_TURN_STORE, LANGUAGE_PRACTICE_SESSION_STORE,
    require('../../dist/language-practice/practice-audio.service.js').PracticeAudioService,
    require('../../dist/language-practice/piper-runtime.providers.js').PIPER_RUNTIME,
    LANGUAGE_PRACTICE_TURN_COACH,
  ]);
  const calls = [];
  const store = {
    reserveTurn: async (...args) => { calls.push(['reserveTurn', ...args]); return calls.filter(([name]) => name === 'reserveTurn').length === 1 ? reservation(false) : reservation(true); },
    completeTurn: async (...args) => { calls.push(['completeTurn', ...args]); return true; },
    failTurn: async (...args) => { calls.push(['failTurn', ...args]); return true; },
    getCompletedHistory: async (...args) => { calls.push(['getCompletedHistory', ...args]); return []; },
  };
  const sessionStore = { getSession: async (...args) => { calls.push(['getSession', ...args]); return { status: 'ACTIVE', level: 'A2', topic: 'work' }; } };
  const audio = { transcribe: async (...args) => { calls.push(['transcribe', ...args]); return 'hello'; } };
  const piper = { getHost: (language) => { calls.push(['getHost', language]); return { synthesize: async (text) => { calls.push(['synthesize', text]); return Buffer.from('wav'); } }; } };
  const coach = { respond: async (input) => { calls.push(['coach', input]); return { correctedPhrase: 'hola', feedback: 'ok', assistantResponse: 'Good morning.' }; } };
  const service = serviceProvider.useFactory(store, sessionStore, audio, piper, coach);
  await service.processTurn(ownerId, sessionId, clientTurnId, { buffer: Buffer.from('audio'), mimeType: 'audio/wav' });
  assert.deepEqual(calls.map(([name]) => name), [
    'reserveTurn', 'getSession', 'getCompletedHistory', 'transcribe', 'coach', 'getHost', 'synthesize',
    'completeTurn', 'reserveTurn',
  ]);
  assert.deepEqual(calls[0], ['reserveTurn', ownerId, sessionId, clientTurnId]);
  assert.deepEqual(calls[1], ['getSession', ownerId, sessionId]);
  assert.deepEqual(calls[2], ['getCompletedHistory', ownerId, sessionId]);
  assert.deepEqual(calls[3], ['transcribe', Buffer.from('audio'), 'audio/wav']);
  assert.deepEqual(calls[5], ['getHost', 'en']);
  assert.deepEqual(calls[6], ['synthesize', 'Good morning.']);
  assert.deepEqual(calls[7], [
    'completeTurn', ownerId, sessionId, turnId, leaseToken, 'hello', 'Good morning.',
    JSON.stringify({ correctedPhrase: 'hola', feedback: 'ok' }),
  ]);
  assert.deepEqual(calls[8], ['reserveTurn', ownerId, sessionId, clientTurnId]);
});

test('does not supply fake/default history when the required history port is missing or fails', async () => {
  assert.throws(() => assembleLanguagePracticeTurnService({
    turnStore: {}, sessions: {}, speechToText: {}, synthesis: {}, coach: {},
  }), /All language-practice turn ports are required/);
  const calls = [];
  const service = assembleLanguagePracticeTurnService({
    turnStore: { reserveTurn: async (...args) => { calls.push(['reserve', ...args]); return reservation(false); }, failTurn: async () => true },
    sessions: { getOwnedSession: async () => ({ level: 'A1', topic: 'work' }) },
    history: { getCompletedHistory: async (...args) => { calls.push(['history', ...args]); throw new Error('unavailable'); } },
    speechToText: { transcribeBounded: async () => { calls.push(['stt']); return 'unexpected'; } },
    synthesis: { synthesizeLocal: async () => Buffer.from('wav') },
    coach: { respond: async () => { throw new Error('unexpected'); } },
  });
  await assert.rejects(service.processTurn(ownerId, sessionId, clientTurnId, { buffer: Buffer.from('x'), mimeType: 'audio/wav' }), PracticeTurnUnavailableError);
  assert.deepEqual(calls, [['reserve', ownerId, sessionId, clientTurnId], ['history', ownerId, sessionId]]);
});

test('invalid or incomplete provider configuration fails closed before inspecting a key file', () => {
  assert.deepEqual(loadLanguagePracticeTurnCoachConfig(env), env ? {
    keyFilePath: '/unit-test/coach.env', model: 'gpt-5.6-luna',
  } : undefined);
  for (const invalid of [
    {},
    { ...env, LINGUALOOP_OPENAI_API_KEY_FILE: '' },
    { ...env, LINGUALOOP_OPENAI_API_KEY_FILE: 'relative/path' },
    { ...env, LINGUALOOP_OPENAI_API_KEY_FILE: '/path\0invalid' },
    { ...env, LANGUAGE_PRACTICE_OPENAI_MODEL: '' },
    { ...env, LANGUAGE_PRACTICE_OPENAI_MODEL: 'not-allowlisted' },
  ]) {
    assert.equal(loadLanguagePracticeTurnCoachConfig(invalid), undefined);
    assert.deepEqual(createLanguagePracticeTurnProviders(invalid), []);
  }
});

test('invalid, unreadable, or malformed key files fail closed before returning Nest providers', () => {
  const invalidFileOptions = [
    { inspectFile: () => { throw new Error('unreadable path'); } },
    { inspectFile: () => ({ isFile: () => false, mode: 0o100600 }) },
    { inspectFile: () => ({ isFile: () => true, mode: 0o100644 }) },
    {
      inspectFile: () => ({ isFile: () => true, mode: 0o100600 }),
      readFile: () => { throw new Error('unreadable file'); },
    },
    {
      inspectFile: () => ({ isFile: () => true, mode: 0o100600 }),
      readFile: () => 'OPENAI_API_KEY=\n',
    },
  ];
  for (const options of invalidFileOptions) {
    assert.deepEqual(createLanguagePracticeTurnProviders(env, options), []);
  }
});

test('valid explicit settings return exactly one provider set with an eager safe adapter', () => {
  let constructions = 0;
  let requests = 0;
  const providers = createLanguagePracticeTurnProviders(env, {
    inspectFile: (path) => {
      assert.equal(path, env.LINGUALOOP_OPENAI_API_KEY_FILE);
      return { isFile: () => true, mode: 0o100600 };
    },
    readFile: (path) => {
      assert.equal(path, env.LINGUALOOP_OPENAI_API_KEY_FILE);
      return 'OPENAI_API_KEY=fake-only-test-value\n';
    },
    OpenAIConstructor: class {
      constructor(options) {
        constructions += 1;
        assert.equal(options.maxRetries, 0);
        assert.equal(options.timeout, 90_000);
        this.responses = { create: async () => { requests += 1; return {}; } };
      }
    },
  });
  assert.equal(providers.length, 2);
  assert.equal(providers.filter((provider) => provider.provide === LANGUAGE_PRACTICE_TURN_COACH).length, 1);
  assert.equal(providers.filter((provider) => provider.provide === LANGUAGE_PRACTICE_TURN_SERVICE).length, 1);
  assert.equal(typeof providers.find((provider) => provider.provide === LANGUAGE_PRACTICE_TURN_COACH).useValue.respond, 'function');
  assert.equal(constructions, 1);
  assert.equal(requests, 0);
});
