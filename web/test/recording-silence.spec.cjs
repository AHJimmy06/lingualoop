const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { RecordingSilenceDetector, monitorRecordingSilence } = require('../src/features/language-practice/recording-silence.ts');

test('initial silence, a click and brief background noise never trigger a turn', () => {
  const detector = new RecordingSilenceDetector();
  for (let now = 0; now <= 5000; now += 100) assert.equal(detector.observe(0, now), false);
  assert.equal(detector.observe(0.1, 5100), false);
  assert.equal(detector.observe(0, 5200), false);
  assert.equal(detector.observe(0, 10000), false);
});

test('voice followed by two seconds of silence triggers exactly once, but short pauses do not', () => {
  const detector = new RecordingSilenceDetector();
  for (const now of [0, 100, 200, 300]) assert.equal(detector.observe(0.04, now), false);
  assert.equal(detector.hasVoiceActivity, true);
  assert.equal(detector.observe(0.002, 1800), false);
  assert.equal(detector.observe(0.04, 1900), false, 'resuming speech resets the silence window');
  assert.equal(detector.observe(0, 3899), false);
  assert.equal(detector.observe(0, 3900), true);
  assert.equal(detector.observe(0, 9999), false, 'never resubmit the same recording');
});

function fakeBrowser(t, state = 'running') {
  const original = { Context: globalThis.AudioContext, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, performance: Object.getOwnPropertyDescriptor(globalThis, 'performance') };
  let time = 0, level = 0, callback;
  const counts = { close: 0, disconnect: 0, cleared: 0 };
  class Context {
    state = state;
    createMediaStreamSource() { return { connect() {}, disconnect() { counts.disconnect++; } }; }
    createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(samples) { samples.fill(level); }, disconnect() { counts.disconnect++; } }; }
    async resume() { throw Error('blocked audio context'); }
    async close() { counts.close++; this.state = 'closed'; }
  }
  globalThis.AudioContext = Context;
  globalThis.setInterval = fn => { callback = fn; return 1; };
  globalThis.clearInterval = () => { counts.cleared++; };
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => time } });
  t.after(() => {
    globalThis.AudioContext = original.Context;
    globalThis.setInterval = original.setInterval;
    globalThis.clearInterval = original.clearInterval;
    Object.defineProperty(globalThis, 'performance', original.performance);
  });
  return { counts, tick(now, amplitude) { time = now; level = amplitude; callback?.(); } };
}

test('local analyser submits once, disconnects nodes and closes context without owning microphone tracks', async t => {
  const browser = fakeBrowser(t);
  let turns = 0;
  const monitor = monitorRecordingSilence({}, () => { turns++; });
  assert.equal(await monitor.ready, true);
  for (const now of [0, 100, 200, 300]) browser.tick(now, 0.05);
  browser.tick(2200, 0);
  assert.equal(turns, 0);
  browser.tick(2300, 0);
  browser.tick(5000, 0);
  monitor.stop();
  assert.equal(turns, 1);
  assert.deepEqual(browser.counts, { close: 1, disconnect: 2, cleared: 1 });
});

test('cancelled detection cannot submit a late turn', async t => {
  const browser = fakeBrowser(t);
  let turns = 0;
  const monitor = monitorRecordingSilence({}, () => { turns++; });
  await monitor.ready;
  for (const now of [0, 100, 200, 300]) browser.tick(now, 0.05);
  monitor.stop();
  browser.tick(5000, 0);
  assert.equal(turns, 0);
  assert.equal(browser.counts.close, 1);
});

test('blocked or unavailable Web Audio falls back to manual recording', async t => {
  const browser = fakeBrowser(t, 'suspended');
  const monitor = monitorRecordingSilence({}, () => assert.fail('must not submit'));
  assert.equal(await monitor.ready, false);
  assert.equal(browser.counts.close, 1);
  globalThis.AudioContext = undefined;
  assert.equal(monitorRecordingSilence({}, () => assert.fail('must not submit')), null);
});
