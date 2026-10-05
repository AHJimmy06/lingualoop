const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { LiveTurnController } = require('../src/features/language-practice/react-live-turn.ts');
const { ResponseAudioUrls } = require('../src/features/language-practice/react-live-audio.ts');
const viewPath = path.join(__dirname, '../src/features/language-practice/LivePracticeView.tsx');
const routesPath = path.join(__dirname, '../src/react-routes.tsx');

test('processing and transport uncertainty preserve one pending recording and ID for manual checks', async () => {
  let nextId = 0;
  const controller = new LiveTurnController(() => `turn-${++nextId}`);
  const blob = new Blob(['voice'], { type: 'audio/webm' });
  const pending = controller.record(blob, true);
  assert.equal(pending.clientTurnId, 'turn-1');
  const calls = [];
  const send = async (sessionId, submittedBlob, id) => {
    calls.push({ sessionId, submittedBlob, id });
    return calls.length === 1 ? { status: 'PROCESSING' } : Promise.reject(new Error('network lost'));
  };

  assert.equal((await controller.check('session-a', send)).kind, 'processing');
  assert.equal(controller.pending, pending);
  assert.equal(controller.canRecord(true), false);
  assert.equal((await controller.check('session-a', send)).kind, 'uncertain');
  assert.equal(controller.pending, pending);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.sessionId === 'session-a' && call.submittedBlob === blob && call.id === pending.clientTurnId));
  assert.equal(controller.submitting, false);
});

test('completed and failed terminal results release the pending turn while errors remain uncertain', async () => {
  for (const status of ['COMPLETED', 'FAILED']) {
    const controller = new LiveTurnController(() => 'stable-turn-id');
    controller.record(new Blob(['voice'], { type: 'audio/webm' }), true);
    const result = await controller.check('session-a', async () => ({ status }));
    assert.equal(result.kind, status.toLowerCase());
    assert.equal(controller.pending, null);
    assert.equal(controller.canRecord(true), true);
  }
});

test('response audio attempts autoplay, exposes fallback replay, and revokes URLs on replace and clear', async () => {
  let nextUrl = 0;
  const revoked = [];
  const urls = new ResponseAudioUrls({
    createObjectURL: () => `blob:response-${++nextUrl}`,
    revokeObjectURL: (url) => revoked.push(url),
  });
  assert.equal(urls.replace({ audioBase64: 'AQID', audioMimeType: 'audio/wav' }), 'blob:response-1');
  assert.equal(await urls.autoplay(async () => { throw new Error('blocked'); }), false);
  assert.equal(urls.manualReplayRequired, true);
  assert.equal(await urls.replay(async () => {}), true);
  assert.equal(urls.manualReplayRequired, false);
  assert.equal(urls.replace({ audioBase64: 'BAUG', audioMimeType: 'audio/wav' }), 'blob:response-2');
  assert.deepEqual(revoked, ['blob:response-1']);
  assert.equal(urls.replace({ audioBase64: null, audioMimeType: null }), null);
  assert.deepEqual(revoked, ['blob:response-1', 'blob:response-2']);
  urls.clear();
  assert.deepEqual(revoked, ['blob:response-1', 'blob:response-2']);
});

test('recorder is remounted per session and stale recorded callbacks cannot submit', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  assert.match(view, /<PracticeRecorder\s+key=\{sessionId\}/);
  const callback = view.match(/const onRecorded = \(blob: Blob\) => \{([\s\S]*?)\n  \};/);
  assert.ok(callback, 'onRecorded callback should exist');
  assert.match(callback[1], /sessionIdRef\.current !== sessionId/);
  assert.ok(callback[1].indexOf('sessionIdRef.current !== sessionId') < callback[1].indexOf('turnController.record('),
    'stale callbacks must return before recording or checking a turn');
});

test('live route renders shadcn left/right message bubbles and standalone recording controls', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  const routes = fs.readFileSync(routesPath, 'utf8');
  assert.match(routes, /<Route path="\/language-practice\/sessions\/:sessionId" element=\{\s*<RouteGate><LivePracticeView \/><\/RouteGate>/);
  assert.match(view, /<Message[^>]*align="start"/);
  assert.match(view, /<Message[^>]*align="end"/);
  assert.match(view, /<BubbleContent/);
  assert.match(view, /<PracticeRecorder/);
  assert.match(view, /Check same turn/);
  assert.match(view, /aria-label="Replay response audio"/);
  assert.doesNotMatch(view, /turn-notice|<textarea|<input[^>]+text/i);
});
