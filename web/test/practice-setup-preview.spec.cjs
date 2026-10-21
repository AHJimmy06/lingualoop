const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: filename,
}).outputText, filename);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(__dirname, '../src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};
const { getPracticeScene } = require('../src/features/language-practice/PracticeScene.tsx');
const { DefaultTopicTiles } = require('../src/features/language-practice/LanguagePracticeSetupView.tsx');
const setupSource = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/LanguagePracticeSetupView.tsx'), 'utf8');
const settingsSource = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/PracticeSettingsDialog.tsx'), 'utf8');
const topics = ['travel', 'work', 'studies', 'everyday-conversation'];
const options = { topics: topics.map(code => ({ code, label: code })), levels: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], durationsMinutes: [5, 10, 15] };
test('twelve variants share four local scenes with one composite selection and a safe fallback', () => {
  assert.equal(new Set(topics.map(topic => getPracticeScene(topic).image)).size, 4);
  assert.equal(getPracticeScene('unknown').image, getPracticeScene('everyday-conversation').image);
  for (const selected of topics) {
    const markup = renderToStaticMarkup(React.createElement(DefaultTopicTiles, { options, topic: selected, difficulty: 'medium', level: 'B2', onSelect() {} }));
    for (const topic of topics) assert.ok(markup.includes(getPracticeScene(topic).image));
    assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.equal((markup.match(/<button/g) ?? []).length, 12);
    assert.equal((markup.match(/alt=""/g) ?? []).length, 12);
    assert.match(markup, /sm:min-h-52/); // Wider layouts must not enlarge artwork height.
    assert.match(markup, /focus-visible:ring/);
    assert.match(markup, /motion-reduce:transition-none/);
    assert.doesNotMatch(markup, /<select|(?:src|href)="https?:\/\//);
  }
  assert.match(setupSource, /role="group" className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="All available practices">[\s\S]*<DefaultTopicTiles[\s\S]*<PracticeCatalogue/);
  assert.doesNotMatch(setupSource, /auto-fill|auto-fit|sm:grid-cols-2/);
});
test('settings are adjacent to logout, use a keyboard modal and apply only to defaults', () => {
  assert.match(setupSource, /<PracticeSettingsDialog[^>]*\/>.*<Button/);
  assert.doesNotMatch(setupSource, /<select/);
  assert.match(settingsSource, /Dialog\.Trigger/);
  assert.match(settingsSource, /Dialog\.Popup/);
  assert.match(settingsSource, /Dialog\.Close/);
  assert.match(settingsSource, /aria-label="Default practice settings"/);
  assert.match(settingsSource, /role="tooltip"/);
  assert.match(settingsSource, /group-focus-within:opacity-100/);
  assert.match(settingsSource, /default activities only/);
  assert.equal((settingsSource.match(/<select/g) || []).length, 2, 'settings should expose CEFR and duration only');
  assert.doesNotMatch(settingsSource, /Task difficulty|LANGUAGE_PRACTICE_DIFFICULTIES/);
  assert.match(setupSource, /Choose a conversation or a teacher-created practice/);
  assert.doesNotMatch(setupSource, /Choose the same activity at Easy, Medium or Hard/);
  assert.match(setupSource, /CEFR \{preferences\.level\} · \{preferences\.durationMinutes\} minutes<\/p>/);
  assert.match(setupSource, /client\.createSession\(\{ \.\.\.preferences, topic:/);
  const catalogue = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/PracticeCatalogue.tsx'), 'utf8');
  assert.doesNotMatch(catalogue, /Teacher-created practices|Select a practice to review/);
  assert.match(catalogue, /<Dialog\.Root open=\{open\}/);
  assert.match(catalogue, /fixed settings and conversation requirements/);
  assert.match(catalogue, /createCustomSession\(\{ practiceId: practice\.id \}\)/);
  assert.doesNotMatch(catalogue, /readPreferences|savePreferences/);
  assert.match(setupSource, /setPracticeDetailsOpen\(true\)/);
  assert.match(setupSource, /<Dialog\.Title className="text-xl font-semibold">Practice details/);
  assert.match(setupSource, /<Button className="mt-4 w-full" size="lg"[\s\S]*'Start practice'/);
  assert.doesNotMatch(setupSource, /Selected:.*Start practice/);
});
