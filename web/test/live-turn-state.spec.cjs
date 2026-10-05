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

const state = require('../src/features/language-practice/live-turn-state.ts');
const component = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/LivePracticeView.tsx'), 'utf8');

test('a pending or in-flight turn blocks recording; only PROCESSING remains pending', () => {
  const turn = { blob: {}, clientTurnId: 'stable-id' };
  assert.equal(state.canRecordTurn(turn, false, true), false);
  assert.equal(state.canRecordTurn(null, true, true), false);
  assert.equal(state.canRecordTurn(null, false, false), false);
  assert.equal(state.canRecordTurn(null, false, true), true);
  assert.equal(state.nextTurnState('PROCESSING'), 'pending');
  assert.equal(state.nextTurnState('COMPLETED'), 'resolved');
  assert.equal(state.nextTurnState('FAILED'), 'resolved');
});

test('React live view uses a stable controller ID and blocks session refresh while pending', () => {
  assert.match(component, /new LiveTurnController\(\)/);
  assert.match(component, /client\.submitTurn\(id, blob, clientTurnId\)/);
  assert.match(component, /Check same turn/);
  assert.match(component, /controllerRef\.current\.pending/);
  assert.match(component, /audioController\.current\.clear\(\)/);
});
