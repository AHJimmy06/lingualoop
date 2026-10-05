const test = require('node:test');
const assert = require('node:assert/strict');
const { LanguagePracticeReportService } = require('../../dist/language-practice/language-practice-report.service.js');
const { LanguagePracticeReportAdmissionError } = require('../../dist/language-practice/language-practice-report-store.js');

const ownerId = '550e8400-e29b-41d4-a716-446655440000';
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const token = '123e4567-e89b-42d3-a456-426614174001';
const report = { sessionId, summary: 'Saved report', corrections: [], strengths: [], recommendations: [], generatedWithAi: false, createdAt: '2026-01-01T00:00:00.000Z' };
const content = { summary: 'Generated', corrections: [], strengths: [], recommendations: [] };
const claimed = { kind: 'claimed', token, turns: [{ sequence: 1, transcript: 'Hola', spanishCorrectionEvidence: null }], topic: 'travel', level: 'B1' };

function fixture(begin = claimed, adapter = { async generate() { return content; } }) {
  const calls = [];
  const store = {
    async beginAiReport(...args) { calls.push(['begin', ...args]); return begin; },
    async releaseAiReport(...args) { calls.push(['release', ...args]); return true; },
    async finalizeAiReport(...args) { calls.push(['finalize', ...args]); return { ...report, generatedWithAi: true }; },
  };
  const ai = { calls: [], async generate(...args) { this.calls.push(args); return adapter.generate(...args); } };
  return { service: new LanguagePracticeReportService(store, adapter ? ai : undefined), calls, ai };
}

test('generates once outside claim acquisition then finalizes with the matching token', async () => {
  const { service, calls, ai } = fixture();
  assert.deepEqual(await service.getOrCreate(ownerId, sessionId), { ...report, generatedWithAi: true });
  assert.deepEqual(calls.map(([kind]) => kind), ['begin', 'finalize']);
  assert.deepEqual(calls[1], ['finalize', ownerId, sessionId, token, content]);
  assert.deepEqual(ai.calls, [[claimed.turns, { topic: 'travel', level: 'B1' }]]);
});

test('existing and no-evidence saved reports bypass the adapter', async () => {
  for (const kind of ['existing', 'no_evidence']) {
    const { service, ai } = fixture({ kind, report }, null);
    assert.deepEqual(await service.getOrCreate(ownerId, sessionId), report);
    assert.deepEqual(ai.calls, []);
  }
});

test('busy claims and missing adapters are unavailable; missing adapter releases its claim', async () => {
  const busy = fixture({ kind: 'busy' });
  await assert.rejects(busy.service.getOrCreate(ownerId, sessionId), /temporarily unavailable/);
  assert.deepEqual(busy.calls.map(([kind]) => kind), ['begin']);
  const absent = fixture(claimed, null);
  await assert.rejects(absent.service.getOrCreate(ownerId, sessionId), /temporarily unavailable/);
  assert.deepEqual(absent.calls, [['begin', ownerId, sessionId], ['release', ownerId, sessionId, token]]);
});

test('provider and finalize failures release matching claim and expose no details; later calls may retry', async () => {
  let count = 0;
  const first = fixture(claimed, { async generate() { count += 1; throw new Error('provider secret detail'); } });
  await assert.rejects(first.service.getOrCreate(ownerId, sessionId), (error) => {
    assert.match(error.message, /temporarily unavailable/);
    assert.doesNotMatch(error.message, /secret|provider/);
    return true;
  });
  assert.deepEqual(first.calls.at(-1), ['release', ownerId, sessionId, token]);

  const retry = fixture(claimed);
  await retry.service.getOrCreate(ownerId, sessionId);
  assert.equal(count, 1);

  const failedFinalize = fixture(claimed);
  failedFinalize.service.store.finalizeAiReport = async () => { throw new Error('database secret'); };
  await assert.rejects(failedFinalize.service.getOrCreate(ownerId, sessionId), /temporarily unavailable/);
  assert.deepEqual(failedFinalize.calls.at(-1), ['release', ownerId, sessionId, token]);
});

test('admission errors preserve their identity for controller mapping', async () => {
  const error = new LanguagePracticeReportAdmissionError('not_closed');
  const { service } = fixture();
  service.store.beginAiReport = async () => { throw error; };
  await assert.rejects(service.getOrCreate(ownerId, sessionId), (actual) => actual === error);
});
