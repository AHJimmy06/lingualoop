const ts = require('typescript');
const Module = require('node:module');
const path = require('node:path');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(require('node:fs').readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: filename,
}).outputText, filename);
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) { return resolve.call(this, request.startsWith('@/') ? path.join(__dirname, '../src', request.slice(2)) : request, parent, isMain, options); };
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const fs = require('node:fs');
const { DefaultTopicTiles } = require('../src/features/language-practice/LanguagePracticeSetupView.tsx');
const { PracticeDetails } = require('../src/features/language-practice/PracticeCatalogue.tsx');
const options = { topics: ['travel', 'work', 'studies', 'everyday-conversation'].map(code => ({ code, label: code })), levels: ['A1'], durationsMinutes: [5] };
test('tile events pass both topic and difficulty, disabled tiles and all alternate selections remain coherent', () => {
  for (const level of ['A1', 'C2']) for (const topic of options.topics) for (const difficulty of ['easy', 'medium', 'hard']) {
    let selected;
    const props = { options, topic: topic.code, difficulty, level, onSelect: (...value) => { selected = value; } };
    const tree = DefaultTopicTiles(props);
    const buttons = tree.props.children.flat();
    assert.equal(buttons.length, 12);
    assert.equal(new Set(buttons.map(button => button.key)).size, 12);
    assert.equal(buttons.filter(button => button.props['aria-pressed']).length, 1);
    for (const button of buttons) {
      button.props.onClick();
      const next = DefaultTopicTiles({ ...props, topic: selected[0], difficulty: selected[1] });
      assert.equal(next.props.children.flat().filter(item => item.props['aria-pressed']).length, 1);
      assert.ok(['easy', 'medium', 'hard'].includes(selected[1]));
    }
    const html = renderToStaticMarkup(React.createElement(DefaultTopicTiles, { ...props, disabled: true }));
    assert.equal((html.match(/disabled=""/g) || []).length, 12);
    for (const label of ['Easy', 'Medium', 'Hard', level]) assert.ok(html.includes(label));
  }
});
test('catalogue details display recorded difficulty without inventing historical medium', () => {
  const practice = { id: 'draft', title: 'Theme', teacherName: 'Teacher', image: null, parameters: [], setup: { level: 'A1', durationMinutes: 5 } };
  for (const [difficulty, label] of [[null, 'Difficulty not recorded'], ['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']]) {
    const html = renderToStaticMarkup(React.createElement(PracticeDetails, { practice: { ...practice, setup: { ...practice.setup, difficulty } } }));
    assert.ok(html.includes(label));
  }
});
test('settings draft changes difficulty without changing CEFR or time, saves only defaults', () => {
  const { PracticeSettingsDialog } = require('../src/features/language-practice/PracticeSettingsDialog.tsx');
  const original = React.useState;
  const states = []; let cursor = 0; let saved;
  React.useState = initial => {
    const at = cursor++;
    if (!(at in states)) states[at] = initial;
    return [states[at], value => { states[at] = value; }];
  };
  function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)]; }
  const value = { level: 'A1', durationMinutes: 5, difficulty: 'medium' };
  function render() { cursor = 0; return PracticeSettingsDialog({ options, value, onSave: draft => { saved = draft; } }); }
  try {
    let tree = render();
    tree.props.onOpenChange(true);
    tree = render();
    nodes(tree).filter(node => node.type === 'select')[2].props.onChange({ target: { value: 'hard' } });
    tree = render();
    assert.deepEqual(nodes(tree).filter(node => node.type === 'select').map(node => node.props.value), ['A1', 5, 'hard']);
    nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    assert.deepEqual(saved, { ...value, difficulty: 'hard' });
    tree.props.onOpenChange(true);
    assert.deepEqual(nodes(render()).filter(node => node.type === 'select').map(node => node.props.value), ['A1', 5, 'medium']);
  } finally { React.useState = original; }
});
test('normalizing remote options preserves local difficulty and custom start never sends overrides', () => {
  const setup = fs.readFileSync(require.resolve('../src/features/language-practice/LanguagePracticeSetupView.tsx'), 'utf8');
  assert.match(setup, /setPreferences\(current => \(\{\s*\.\.\.current,/);
  assert.match(setup, /pending.current/);
  assert.match(setup, /claimStart=\{claimStart\}/);
  const catalogue = fs.readFileSync(require.resolve('../src/features/language-practice/PracticeCatalogue.tsx'), 'utf8');
  assert.equal((catalogue.match(/createCustomSession\(\{ practiceId: practice.id \}\)/g) || []).length, 2);
});
