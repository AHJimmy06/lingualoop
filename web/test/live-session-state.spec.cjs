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
const routesPath = path.join(__dirname, '../src/react-routes.tsx');
const routesSource = fs.readFileSync(routesPath, 'utf8');
const setupPath = path.join(__dirname, '../src/features/language-practice/LanguagePracticeSetupView.tsx');
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

test('registers React session and completion routes behind the session gate', () => {
  assert.match(routesSource, /path="\/language-practice\/sessions\/:sessionId"[\s\S]*?<RouteGate><LivePracticeView \/><\/RouteGate>/);
  assert.match(routesSource, /path="\/language-practice\/sessions\/:sessionId\/complete"[\s\S]*?<RouteGate><PracticeReportView \/><\/RouteGate>/);
  assert.match(setupSource, /client\.createSession\(setup\)/);
  assert.match(setupSource, /navigate\(`\/language-practice\/sessions\/\$\{created\.id\}`\)/);
  assert.match(setupSource, /if \(creating \|\| !options \|\| !canStart \|\| duration === null\) return/);
});

test('React entry remains active without legacy Vue bootstrap, router, or views', () => {
  const entryPath = path.join(__dirname, '../src/main.tsx');
  const htmlPath = path.join(__dirname, '../index.html');
  const entrySource = fs.readFileSync(entryPath, 'utf8');
  const htmlSource = fs.readFileSync(htmlPath, 'utf8');
  assert.match(htmlSource, /src="\/src\/main\.tsx"/);
  assert.match(entrySource, /createRoot\(root\)\.render/);
  for (const vueOnlyFile of [
    '../src/main.ts',
    '../src/router.ts',
    '../src/App.vue',
    '../src/features/auth/LoginView.vue',
    '../src/features/language-practice/LanguagePracticeSetupView.vue',
    '../src/features/language-practice/LivePracticeView.vue',
    '../src/features/language-practice/PracticeRecorder.vue',
    '../src/features/language-practice/PracticeReportView.vue',
  ]) assert.equal(fs.existsSync(path.join(__dirname, vueOnlyFile)), false, `${vueOnlyFile} must not be required`);
});
