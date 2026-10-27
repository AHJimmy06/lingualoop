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

const { RecordingBuffer } = require('../src/features/language-practice/react-recorder-state.ts');

test('recording buffer accepts a valid payload exactly once and enforces duration and size bounds', () => {
  const buffer = new RecordingBuffer();
  buffer.add(new Blob(['audio'], { type: 'audio/webm' }));
  const recorded = buffer.finish(250, 'audio/webm');

  assert.equal(recorded.type, 'audio/webm');
  assert.equal(recorded.size, 5);
  assert.equal(buffer.finish(250, 'audio/webm'), null);

  assert.equal(new RecordingBuffer().finish(249, 'audio/webm'), null);
  assert.equal(new RecordingBuffer().finish(600_001, 'audio/webm'), null);
  const oversized = new RecordingBuffer();
  oversized.add(new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]));
  assert.equal(oversized.finish(20_000, 'audio/webm'), null);
});

test('recorder exposes starting and recording state without changing guarded shortcut or upload behavior', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/PracticeRecorder.tsx'), 'utf8');
  assert.match(source, /onBusyChange\?: \(busy: boolean\) => void/);
  assert.match(source, /onBusyChangeRef\.current\?\.\(starting \|\| recording\)/);
  assert.doesNotMatch(source, /Ready to record|You can start when ready|Press Space when no interactive control is focused\. Maximum 20 seconds\./);
  assert.match(source, /\{\(starting \|\| recording\) && <p[^>]*role="status"/);
});

test('recorder source preserves guarded Space behavior and cancels stale captures without upload', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/PracticeRecorder.tsx'), 'utf8');
  assert.match(source, /isRecorderShortcut\(event, disabled\)/);
  assert.match(source, /getUserMedia\(\{ audio: true, video: false \}\)/);
  assert.match(source, /operation !== operationRef\.current/);
  assert.match(source, /onRecordedRef\.current\(blob\)/);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest/);
});
