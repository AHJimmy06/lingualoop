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

const path = require('node:path');
const { SpeakingEventState } = require('../src/features/language-practice/react-live-audio.ts');

class FakeRecorder extends EventTarget {
  start() { this.dispatchEvent(new Event('start')); }
  stop() { this.dispatchEvent(new Event('stop')); }
  fail() { this.dispatchEvent(new Event('error')); }
}

test('learner speaks only for recorder start through stop, error, or cleanup events', () => {
  const states = [];
  const speaking = new SpeakingEventState((active) => states.push(active), 'start', ['stop', 'error']);
  const recorder = new FakeRecorder();
  const detach = speaking.attach(recorder);

  recorder.start();
  assert.equal(speaking.speaking, true);
  recorder.stop();
  assert.equal(speaking.speaking, false);
  recorder.start();
  recorder.fail();
  assert.equal(speaking.speaking, false);
  recorder.start();
  detach();
  assert.equal(speaking.speaking, false);
  recorder.start();
  assert.equal(speaking.speaking, false, 'detached recorder must not revive stale speech');
  assert.deepEqual(states, [true, false, true, false, true, false]);
});

test('microphone startup and upload remain separate from speaking state', () => {
  const states = [];
  const speaking = new SpeakingEventState((active) => states.push(active), 'start', ['stop', 'error']);
  const recorder = new FakeRecorder();
  const detach = speaking.attach(recorder);
  assert.equal(speaking.speaking, false, 'no recorder start event during microphone acquisition');
  recorder.start();
  recorder.stop();
  assert.equal(speaking.speaking, false, 'recording submission follows stop and is not speech');
  assert.deepEqual(states, [true, false]);
  detach();
});

test('PracticeRecorder binds speech lifecycle to the MediaRecorder rather than microphone busy state', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/PracticeRecorder.tsx'), 'utf8');
  assert.match(source, /activity\.attach\(recorder\)/);
  assert.match(source, /new SpeakingEventState\([\s\S]*?'start', \['stop', 'error'\]\)/);
  assert.match(source, /onRecordingChangeRef\.current\?\.\(isSpeaking\)/);
  assert.doesNotMatch(source, /onRecordingChangeRef\.current\.?.\(starting/);
});
