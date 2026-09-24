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

const { anchorTimer, projectRemainingMs } = require('../src/features/language-practice/live-session-state.ts');
const routerPath = path.join(__dirname, '../src/router.ts');
const routerSource = fs.readFileSync(routerPath, 'utf8');
const setupPath = path.join(__dirname, '../src/features/language-practice/LanguagePracticeSetupView.vue');
const setupSource = fs.readFileSync(setupPath, 'utf8');

test('projects server remaining time against a monotonic clock without increasing it', () => {
  const anchor = anchorTimer(12_500, 100);
  assert.equal(projectRemainingMs(anchor, 100), 12_500);
  assert.equal(projectRemainingMs(anchor, 2_600), 10_000);
  assert.equal(projectRemainingMs(anchor, 15_000), 0);
  assert.equal(projectRemainingMs(anchor, 50), 12_500, 'a clock value before the snapshot must not add time');
});

test('a fresh server snapshot replaces the previous countdown anchor', () => {
  const snapshot = anchorTimer(4_000, 8_000);
  assert.equal(projectRemainingMs(snapshot, 9_250), 2_750);
  assert.equal(projectRemainingMs(anchorTimer(0, 9_000), 9_000), 0);
});

test('registers protected session and completion routes with the existing report view', () => {
  assert.match(routerSource, /path: '\/language-practice\/sessions\/:sessionId',\s*name: 'language-practice-session'[\s\S]*?LivePracticeView\.vue'[\s\S]*?requiresAuth: true/);
  assert.match(routerSource, /path: '\/language-practice\/sessions\/:sessionId\/complete',\s*name: 'language-practice-completion'[\s\S]*?PracticeReportView\.vue'[\s\S]*?requiresAuth: true/);
  assert.match(setupSource, /createSession\(/);
  assert.match(setupSource, /router\.push\(`\/language-practice\/sessions\/\$\{created\.id\}`\)/);
  assert.match(setupSource, /if \(creating\.value \|\| !options\.value \|\| !canStart\.value\) return/);
});
