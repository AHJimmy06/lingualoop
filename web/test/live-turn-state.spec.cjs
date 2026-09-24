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
const component = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/LivePracticeView.vue'), 'utf8');

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

test('recorded audio gets one stable ID, and Check same turn reuses the pending blob and ID', () => {
  assert.equal((component.match(/crypto\.randomUUID\(\)/g) || []).length, 1);
  assert.match(component, /client\.submitTurn\(requestedSessionId, turn\.blob, turn\.clientTurnId\)/);
  assert.match(component, /@click="sendPendingTurn\(pendingTurn\)"/);
  assert.match(component, /pendingTurn\.value = null[\s\S]*?response\.status === 'FAILED'/);
  assert.match(component, /if \(disposed \|\| sessionId\.value !== requestedSessionId \|\| pendingTurn\.value !== turn\) return/);
  assert.match(component, /requestInFlight \|\| pendingTurn\.value/);
  assert.match(component, /URL\.revokeObjectURL\(audioUrl\.value\)/);
  assert.match(component, /response\.audioMimeType !== 'audio\/wav'/);
  assert.doesNotMatch(component, /Voice turn controls are connecting/);
});
