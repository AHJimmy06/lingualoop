const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.tsx'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { getPracticeScene } = require('../src/features/language-practice/PracticeScene.tsx');
const setupSource = fs.readFileSync(
  path.join(__dirname, '../src/features/language-practice/LanguagePracticeSetupView.tsx'),
  'utf8',
);

test('setup preview uses the existing scene mapping for every topic and its fallback', () => {
  const topics = ['travel', 'work', 'studies', 'everyday-conversation'];
  const previews = topics.map((topic) => getPracticeScene(topic));
  assert.equal(new Set(previews.map((preview) => preview.image)).size, 4);
  assert.equal(getPracticeScene('unknown').image, getPracticeScene('everyday-conversation').image);
  assert.match(setupSource, /getPracticeScene\(topic\)/);
  assert.doesNotMatch(setupSource, /travel-scene\.svg|work-scene\.svg|studies-scene\.svg|everyday-conversation-scene\.svg/);
});

test('setup preview is decorative, updates its visible topic title, and precedes one responsive row of native selectors', () => {
  assert.match(setupSource, /getPracticeScene\(topic\)\.image/);
  assert.match(setupSource, /alt=""[^>]*aria-hidden="true"|aria-hidden="true"[^>]*alt=""/);
  assert.match(setupSource, /options\.topics\.find\(\(item\) => item\.code === topic\)\?\.label/);
  const preview = setupSource.indexOf('getPracticeScene(topic)');
  const controls = setupSource.indexOf('id="practice-topic"');
  assert.ok(preview >= 0 && controls > preview, 'preview should appear before selectors');
  assert.match(setupSource, /grid-cols-1[^"']*sm:grid-cols-3/);
  assert.match(setupSource, /<label[^>]*htmlFor="practice-topic"/);
  assert.match(setupSource, /<label[^>]*htmlFor="practice-level"/);
  assert.match(setupSource, /<label[^>]*htmlFor="practice-duration"/);
  assert.match(setupSource, /<select id="practice-topic"/);
  assert.match(setupSource, /<select id="practice-level"/);
  assert.match(setupSource, /<select id="practice-duration"/);
});
