const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LanguagePracticeTurnService,
  PracticeTurnUnavailableError,
} = require('../../dist/language-practice/language-practice-turn.service.js');
const { LanguagePracticeTurnAdmissionError } = require('../../dist/language-practice/language-practice-turn-store.js');

const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const SESSION = '223e4567-e89b-42d3-a456-426614174000';
const CLIENT = '323e4567-e89b-42d3-a456-426614174000';
const TURN = '423e4567-e89b-42d3-a456-426614174000';
const LEASE = '523e4567-e89b-42d3-a456-426614174000';
const initialTurn = (status = 'PROCESSING') => ({
  id: TURN, clientTurnId: CLIENT, sequence: 1, status, leaseToken: LEASE,
  transcript: null, assistantResponse: null, spanishCorrectionEvidence: null, completedAt: null,
});
const result = {
  correctedPhrase: 'Ayer fui al mercado.',
  feedback: 'El verbo fue debe ir en pretérito para indicar una acción pasada.',
  assistantResponse: 'That sounds like a useful trip. What did you find at the market?',
};

function fixture(overrides = {}) {
  const calls = { reserve: [], session: [], history: [], stt: [], coach: [], tts: [], complete: [], fail: [] };
  const ports = {
    turnStore: {
      async reserveTurn(...args) {
        calls.reserve.push(args);
        if (calls.reserve.length > 1) return { turn: {
          ...initialTurn('COMPLETED'), transcript: 'Yesterday I go to the market.',
          assistantResponse: result.assistantResponse,
          spanishCorrectionEvidence: JSON.stringify({ correctedPhrase: result.correctedPhrase, feedback: result.feedback }),
          completedAt: '2025-04-03T12:34:56.000Z',
        }, replay: true };
        return { turn: initialTurn(), replay: false };
      },
      async completeTurn(...args) { calls.complete.push(args); return true; },
      async failTurn(...args) { calls.fail.push(args); return true; },
    },
    sessions: { async getOwnedSession(...args) { calls.session.push(args); return { level: 'B1', topic: 'travel' }; } },
    history: { async getCompletedHistory(...args) { calls.history.push(args); return [{ role: 'user', content: 'I like trains.' }]; } },
    speechToText: { async transcribeBounded(...args) { calls.stt.push(args); return 'Yesterday I go to the market.'; } },
    synthesis: { async synthesizeLocal(...args) { calls.tts.push(args); return Buffer.from('wav'); } },
    coach: { async respond(...args) { calls.coach.push(args); return result; } },
    ...overrides,
  };
  return { service: new LanguagePracticeTurnService(ports), calls, ports };
}

const audio = () => ({ buffer: Buffer.from('caller audio'), mimeType: 'audio/webm' });

test('forwards owner through reserve and owned context/history, coaches exactly once, persists evidence and synthesizes locally', async () => {
  const { service, calls } = fixture();
  const input = audio();
  const response = await service.processTurn(OWNER, SESSION, CLIENT, input);
  assert.deepEqual(calls.reserve, [[OWNER, SESSION, CLIENT], [OWNER, SESSION, CLIENT]]);
  assert.deepEqual(calls.session, [[OWNER, SESSION]]);
  assert.deepEqual(calls.history, [[OWNER, SESSION]]);
  assert.equal(calls.stt.length, 1);
  assert.equal(calls.coach.length, 1);
  assert.deepEqual(calls.coach[0][0], {
    context: { targetLanguage: { code: 'en', label: 'English' }, topic: { code: 'travel', label: 'Travel' }, source: 'practice-catalog' },
    level: 'B1', transcript: 'Yesterday I go to the market.', history: [{ role: 'user', content: 'I like trains.' }],
  });
  assert.deepEqual(calls.tts, [[result.assistantResponse, 'en']]);
  assert.equal(calls.complete.length, 1);
  assert.deepEqual(JSON.parse(calls.complete[0][6]), { correctedPhrase: result.correctedPhrase, feedback: result.feedback });
  assert.equal(response.turn.status, 'COMPLETED');
  assert.equal(response.turn.completedAt, '2025-04-03T12:34:56.000Z', 'returns the persisted database timestamp');
  assert.equal(response.turn.transcript, 'Yesterday I go to the market.');
  assert.equal(response.turn.assistantResponse, result.assistantResponse);
  assert.equal(response.audioWav.toString(), 'wav');
  assert.deepEqual([...input.buffer], [...Buffer.from('caller audio')], 'caller-owned buffer is not mutated');
});

test('post-completion reread must match the committed persisted turn and never fails it again', async () => {
  const invalidSnapshots = [
    (turn) => ({ ...turn, id: '623e4567-e89b-42d3-a456-426614174000' }),
    (turn) => ({ ...turn, status: 'PROCESSING' }),
    (turn) => ({ ...turn, transcript: 'different transcript' }),
    (turn) => ({ ...turn, assistantResponse: 'different response' }),
    (turn) => ({ ...turn, completedAt: null }),
  ];
  for (const alter of invalidSnapshots) {
    const { service, calls, ports } = fixture();
    ports.turnStore.reserveTurn = async (...args) => {
      calls.reserve.push(args);
      if (calls.reserve.length === 1) return { turn: initialTurn(), replay: false };
      return { turn: alter({
        ...initialTurn('COMPLETED'), transcript: 'Yesterday I go to the market.',
        assistantResponse: result.assistantResponse, completedAt: '2025-04-03T12:34:56.000Z',
      }), replay: true };
    };
    const input = audio();
    const original = Buffer.from(input.buffer);
    await assert.rejects(service.processTurn(OWNER, SESSION, CLIENT, input), PracticeTurnUnavailableError);
    assert.equal(calls.complete.length, 1);
    assert.equal(calls.reserve.length, 2);
    assert.equal(calls.fail.length, 0, 'committed turn is never charged/failed again');
    assert.equal(calls.coach.length, 1, 'reread does not invoke coach again');
    assert.deepEqual(input.buffer, original, 'caller-owned buffer remains untouched');
  }

  for (const reread of [
    async () => ({ turn: {
      ...initialTurn('COMPLETED'), transcript: 'Yesterday I go to the market.',
      assistantResponse: result.assistantResponse, completedAt: '2025-04-03T12:34:56.000Z',
    }, replay: false }),
    async () => { throw new Error('private reread failure'); },
  ]) {
    const { service, calls, ports } = fixture();
    ports.turnStore.reserveTurn = async (...args) => {
      calls.reserve.push(args);
      return calls.reserve.length === 1 ? { turn: initialTurn(), replay: false } : reread();
    };
    await assert.rejects(service.processTurn(OWNER, SESSION, CLIENT, audio()), PracticeTurnUnavailableError);
    assert.equal(calls.fail.length, 0);
    assert.equal(calls.coach.length, 1);
  }
});

test('PROCESSING, COMPLETED, and FAILED replays return stored turn without history or inference', async () => {
  for (const status of ['PROCESSING', 'COMPLETED', 'FAILED']) {
    const base = fixture();
    base.ports.turnStore.reserveTurn = async (...args) => {
      base.calls.reserve.push(args);
      return { turn: initialTurn(status), replay: true };
    };
    const input = audio();
    const response = await base.service.processTurn(OWNER, SESSION, CLIENT, input);
    assert.equal(response.turn.status, status);
    assert.equal(response.turn.id, TURN);
    assert.equal(response.audioWav, null);
    assert.deepEqual(base.calls.reserve, [[OWNER, SESSION, CLIENT]]);
    for (const name of ['session', 'history', 'stt', 'coach', 'tts', 'complete', 'fail']) assert.equal(base.calls[name].length, 0, `${status}: ${name}`);
    assert.deepEqual([...input.buffer], [...Buffer.from('caller audio')]);
  }
});

test('post-admission failures call fail once and expose only generic unavailable error', async () => {
  for (const failure of ['context', 'history', 'stt', 'coach', 'tts', 'complete', 'complete-false']) {
    const { service, calls, ports } = fixture();
    const detail = `private ${failure} detail`;
    if (failure === 'context') ports.sessions.getOwnedSession = async () => { throw new Error(detail); };
    if (failure === 'history') ports.history.getCompletedHistory = async () => { throw new Error(detail); };
    if (failure === 'stt') ports.speechToText.transcribeBounded = async () => { throw new Error(detail); };
    if (failure === 'coach') ports.coach.respond = async (...args) => { calls.coach.push(args); throw new Error(detail); };
    if (failure === 'tts') ports.synthesis.synthesizeLocal = async (...args) => { calls.tts.push(args); throw new Error(detail); };
    if (failure === 'complete') ports.turnStore.completeTurn = async () => { throw new Error(detail); };
    if (failure === 'complete-false') ports.turnStore.completeTurn = async (...args) => { calls.complete.push(args); return false; };
    await assert.rejects(service.processTurn(OWNER, SESSION, CLIENT, audio()), (error) => {
      assert.ok(error instanceof PracticeTurnUnavailableError);
      assert.doesNotMatch(error.message, /private|context|history|stt|coach|tts|complete/i);
      return true;
    });
    assert.equal(calls.fail.length, 1, failure);
    assert.deepEqual(calls.fail[0], [OWNER, SESSION, TURN, LEASE]);
    assert.equal(calls.coach.length, failure === 'coach' ? 1 : ['tts', 'complete', 'complete-false'].includes(failure) ? 1 : 0);
  }
});

test('reserve failure does not mark unadmitted turn failed and preserves admission outcomes', async () => {
  const { service, calls, ports } = fixture();
  ports.turnStore.reserveTurn = async () => { throw new Error('store detail'); };
  await assert.rejects(service.processTurn(OWNER, SESSION, CLIENT, audio()), PracticeTurnUnavailableError);
  assert.equal(calls.fail.length, 0);
  assert.equal(calls.coach.length, 0);

  for (const reason of ['not_found', 'session_expired', 'turn_in_progress']) {
    ports.turnStore.reserveTurn = async () => { throw new LanguagePracticeTurnAdmissionError(reason); };
    await assert.rejects(service.processTurn(OWNER, SESSION, CLIENT, audio()), (error) => {
      assert.ok(error instanceof LanguagePracticeTurnAdmissionError);
      assert.equal(error.reason, reason);
      return true;
    });
  }
  assert.equal(calls.fail.length, 0);
  assert.equal(calls.coach.length, 0);
});

test('invalid UUID, MIME, and size fail before reserve and preserve caller audio', async () => {
  for (const [owner, session, client, supplied] of [
    ['bad', SESSION, CLIENT, audio()],
    [OWNER, 'bad', CLIENT, audio()],
    [OWNER, SESSION, 'bad', audio()],
    [OWNER, SESSION, CLIENT, { buffer: Buffer.from('x'), mimeType: 'text/plain' }],
    [OWNER, SESSION, CLIENT, { buffer: Buffer.alloc(2 * 1024 * 1024 + 1), mimeType: 'audio/webm' }],
  ]) {
    const { service, calls } = fixture();
    const original = Buffer.from(supplied.buffer);
    await assert.rejects(service.processTurn(owner, session, client, supplied), TypeError);
    assert.equal(calls.reserve.length, 0);
    assert.deepEqual(supplied.buffer, original);
  }
});
