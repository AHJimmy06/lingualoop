const test = require('node:test');
const assert = require('node:assert/strict');
const { LanguagePracticeReportService } = require('../../dist/language-practice/language-practice-report.service.js');
const { LanguagePracticeReportAdmissionError } = require('../../dist/language-practice/language-practice-report-store.js');

const ownerId = '550e8400-e29b-41d4-a716-446655440000';
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const token = '123e4567-e89b-42d3-a456-426614174001';
const report = { sessionId, summary: 'Saved report', corrections: [], strengths: [], recommendations: [], generatedWithAi: false, createdAt: '2026-01-01T00:00:00.000Z' };
const content = { summary: 'Generated', corrections: [], strengths: [], recommendations: [] };
const claimed = { kind: 'claimed', token, turns: [{ sequence: 1, transcript: 'Hola', spanishCorrectionEvidence: null }], topic: 'travel', level: 'B1', difficulty: null };

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
  assert.deepEqual(ai.calls, [[claimed.turns, { topic: 'travel', level: 'B1', difficulty: null }]]);
});

test('forwards trusted admission difficulty without adding it to public reports', async () => {
  for (const difficulty of ['easy', 'medium', 'hard', null]) {
    const f = fixture({ ...claimed, difficulty });
    const saved = await f.service.getOrCreate(ownerId, sessionId);
    assert.equal(f.ai.calls[0][1].difficulty, difficulty);
    assert.equal(Object.hasOwn(saved, 'difficulty'), false);
  }
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

test('one safe primary event survives release failure and throwing sinks across service stages', async () => {
  const poison = new Error('PRIVATE transcript /path token');
  for (const key of ['message', 'name', 'code', 'stack', 'cause', 'diagnostic']) {
    Object.defineProperty(poison, key, { get() { throw new Error('must not inspect'); } });
  }
  for (const [stage, code] of [
    ['admission', 'admission_store'], ['admission', 'busy'],
    ['configuration', 'adapter_unavailable'], ['generation', 'generation_unknown'],
    ['finalize', 'finalize_store'], ['finalize', 'claim_lost'],
  ]) {
    const f = fixture(code === 'busy' ? { kind: 'busy' } : claimed);
    if (code === 'admission_store') f.service.store.beginAiReport = async () => { throw poison; };
    if (code === 'adapter_unavailable') f.service.adapter = undefined;
    if (code === 'generation_unknown') f.service.adapter.generate = async () => { throw poison; };
    if (code === 'finalize_store') f.service.store.finalizeAiReport = async () => { throw poison; };
    if (code === 'claim_lost') f.service.store.finalizeAiReport = async () => null;
    f.service.store.releaseAiReport = async () => { throw poison; };
    const events = [];
    const service = new LanguagePracticeReportService(f.service.store, f.service.adapter, {
      report(event) { events.push(event); throw poison; },
    });
    await assert.rejects(service.getOrCreate(ownerId, sessionId), /temporarily unavailable/);
    assert.deepEqual(events[0], { event: 'language_practice_report_failure', stage, code, component: 'report_service' });
    assert.equal(events.filter(e => e.event === 'language_practice_report_failure').length, 1);
    if (!['admission_store', 'busy'].includes(code)) {
      assert.deepEqual(events[1], { event: 'language_practice_report_release_failure', stage: 'release', code: 'release_store', component: 'report_service' });
    } else assert.equal(events.length, 1);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|transcript|token|path|550e8400|123e4567/);
  }
});

test('service preserves private AI provenance and bypasses diagnostics for saved reports', async () => {
  const { LanguagePracticeReportAiAdapter } = require('../../dist/language-practice/language-practice-report-ai.js');
  const { APIError } = require('openai');
  let calls = 0;
  const adapter = new LanguagePracticeReportAiAdapter({ responses: { async create() {
    calls++; throw new APIError(401, undefined, 'PRIVATE transcript', undefined);
  } } }, 'model');
  const f = fixture();
  const events = [];
  const service = new LanguagePracticeReportService(f.service.store, adapter, { report(event) { events.push(event); } });
  await assert.rejects(service.getOrCreate(ownerId, sessionId), /temporarily unavailable/);
  assert.deepEqual(events, [{ event: 'language_practice_report_failure', stage: 'generation', code: 'provider_http', component: 'ai_provider', providerStatus: 401, providerCategory: 'authentication' }]);
  assert.equal(calls, 1);
  f.service.store.beginAiReport = async () => ({ ...claimed, turns: [{ ...claimed.turns[0], transcript: '' }] });
  await assert.rejects(service.getOrCreate(ownerId, sessionId), /temporarily unavailable/);
  assert.equal(events[1].code, 'invalid_input');
  assert.equal(calls, 1);
  for (const kind of ['existing', 'no_evidence']) {
    f.service.store.beginAiReport = async () => ({ kind, report });
    assert.deepEqual(await service.getOrCreate(ownerId, sessionId), report);
  }
  assert.equal(events.length, 2);
  assert.equal(calls, 1);
});

test('default sink writes only safe structured fields and sink failure cannot change the result', async () => {
  const original = console.error;
  const events = [];
  console.error = (...args) => { events.push(args); throw new Error('PRIVATE sink detail'); };
  try {
    const f = fixture(claimed, { async generate() {
      throw { code: 'provider_http', providerStatus: 401, diagnostic: 'PRIVATE', message: claimed.turns[0].transcript };
    } });
    await assert.rejects(f.service.getOrCreate(ownerId, sessionId), /temporarily unavailable/);
    assert.deepEqual(events, [['language_practice_report_failure', {
      stage: 'generation', code: 'generation_unknown', component: 'report_service',
    }]]);
    assert.deepEqual(f.calls.at(-1), ['release', ownerId, sessionId, token]);
  } finally { console.error = original; }
});

test('later explicit call may retry once, without automatic retry or success diagnostics', async () => {
  let count = 0;
  const f = fixture(claimed, { async generate() {
    if (++count === 1) throw new Error('PRIVATE');
    return content;
  } });
  const events = [];
  const service = new LanguagePracticeReportService(f.service.store, f.service.adapter, { report(event) { events.push(event); } });
  await assert.rejects(service.getOrCreate(ownerId, sessionId), /temporarily unavailable/);
  assert.equal(count, 1);
  assert.deepEqual(await service.getOrCreate(ownerId, sessionId), { ...report, generatedWithAi: true });
  assert.equal(count, 2);
  assert.equal(events.length, 1);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['begin', 'release', 'begin', 'finalize']);
});

test('admission errors preserve their identity for controller mapping without diagnostics', async () => {
  for (const reason of ['not_found', 'not_closed']) {
    const error = new LanguagePracticeReportAdmissionError(reason);
    const f = fixture();
    f.service.store.beginAiReport = async () => { throw error; };
    const events = [];
    const service = new LanguagePracticeReportService(f.service.store, f.service.adapter, { report(event) { events.push(event); } });
    await assert.rejects(service.getOrCreate(ownerId, sessionId), (actual) => actual === error);
    assert.deepEqual(events, []);
    assert.deepEqual(f.ai.calls, []);
  }
});
