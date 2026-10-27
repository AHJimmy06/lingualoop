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

const guards = require('../src/features/language-practice/practice-recorder-guards.ts');
const component = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/PracticeRecorder.tsx'), 'utf8');
const guardsSource = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/practice-recorder-guards.ts'), 'utf8');

test('recording validity enforces positive payload, 250ms minimum, and 32MiB maximum', () => {
  assert.equal(guards.isValidRecording(249, 1), false);
  assert.equal(guards.isValidRecording(250, 1), true);
  assert.equal(guards.isValidRecording(20_000, 2 * 1024 * 1024), true);
  assert.equal(guards.isValidRecording(600_001, 1), false);
  assert.equal(guards.isValidRecording(250, 32 * 1024 * 1024 + 1), false);
  assert.equal(guards.isValidRecording(Number.NaN, 1), false);
  assert.equal(guards.isValidRecording(500, 0), false);
});

test('shortcut guard allows only an unmodified, non-repeated Space key', () => {
  const base = { code: 'Space', repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, target: null };
  assert.equal(guards.isRecorderShortcut(base, false), true);
  for (const patch of [
    { repeat: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true },
    { shiftKey: true }, { defaultPrevented: true }, { code: 'Enter' },
  ]) assert.equal(guards.isRecorderShortcut({ ...base, ...patch }, false), false);
  assert.equal(guards.isRecorderShortcut(base, true), false);
});

test('Space shortcut ignores focused links, summaries, and custom interactive-role ancestors', () => {
  const previousElement = global.Element;
  const previousDocument = global.document;
  class FakeElement {
    constructor(interactiveAncestor) { this.interactiveAncestor = interactiveAncestor; }
    closest() { return this.interactiveAncestor ? this : null; }
  }
  try {
    global.Element = FakeElement;
    const base = { code: 'Space', repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, target: null };
    for (const interactiveAncestor of ['a', 'summary', '[role="button"]', '[role="tab"]', '[role="checkbox"]', '[contenteditable="true"]']) {
      global.document = { activeElement: new FakeElement(interactiveAncestor) };
      assert.equal(guards.isRecorderShortcut(base, false), false, `must ignore ${interactiveAncestor}`);
    }
    global.document = { activeElement: new FakeElement(null) };
    assert.equal(guards.isRecorderShortcut(base, false), true);
  } finally {
    if (previousElement === undefined) delete global.Element;
    else global.Element = previousElement;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});

test('component source uses audio-only capture, supported MIME selection, and no stale recording delivery', () => {
  assert.match(component, /selectSupportedAudioMimeType\(\)/);
  assert.match(component, /getUserMedia\(\{ audio: true, video: false \}\)/);
  assert.match(component, /operation === operationRef\.current && !disposedRef\.current/);
  assert.match(component, /useEffect\([\s\S]*?disposedRef\.current = true/);
  assert.match(guardsSource, /MAX_RECORDING_MS = 600_000/);
  assert.match(guardsSource, /MAX_AUDIO_BYTES = 32 \* 1024 \* 1024/);
  assert.match(component, /requestedDurationRef\.current = performance\.now\(\) - startedAtRef\.current/);
  assert.match(component, /MAX_RECORDING_MS - 500/);
  assert.doesNotMatch(component, /fetch\(|XMLHttpRequest|speechSynthesis/);
});
