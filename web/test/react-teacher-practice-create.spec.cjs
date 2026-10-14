const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: filename }).outputText, filename);
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) { return resolve.call(this, request.startsWith('@/') ? path.join(__dirname, '../src', request.slice(2)) : request, parent, isMain, options); };
const { TeacherPracticesView } = require('../src/features/teacher/TeacherPracticesView.tsx');
test('teacher form has one concrete theme, independent fixed CEFR/time/difficulty and an optional bounded raster picker', () => {
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(TeacherPracticesView)));
  assert.match(html, /Conversation theme/);
  assert.doesNotMatch(html, />Topic<|>Title<|value="travel"|value="work"/);
  assert.equal((html.match(/<select/g) || []).length, 3);
  assert.match(html, /CEFR target level/); assert.match(html, /Duration/);
  assert.match(html, /Task difficulty/);
  assert.match(html, /value="medium" selected=""/);
  assert.match(html, /not assessed proficiency/);
  assert.match(html, /type="file"/); assert.match(html, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /optional/i); assert.match(html, /2 MiB/);
  assert.match(html, /Conversational requirements/);
});
test('draft preview presents current fields without persisted IDs, session actions or a saved fallback cover', () => {
  const { PracticeCardPreview } = require('../src/features/language-practice/PracticeCardPreview.tsx');
  const props = { title: '<script>Draft theme</script>', setup: { level: 'B2', durationMinutes: 15, difficulty: 'hard' }, requirements: ['Ask directions', '', 'Confirm the destination'] };
  let html = renderToStaticMarkup(React.createElement(PracticeCardPreview, props));
  for (const phrase of ['Student-facing preview', 'Not saved', 'Preview placeholder', '&lt;script&gt;Draft theme&lt;/script&gt;', 'B2', '15 minutes', 'Hard', 'Ask directions', 'Confirm the destination']) assert.ok(html.includes(phrase), phrase);
  assert.doesNotMatch(html, /<button|href=|<script>|<img/);
  html = renderToStaticMarkup(React.createElement(PracticeCardPreview, { ...props, title: 'Updated theme', setup: { level: 'C1', durationMinutes: 10, difficulty: 'easy' }, requirements: ['Updated requirement'], imageUrl: 'blob:local-cover' }));
  for (const phrase of ['Updated theme', 'C1', '10 minutes', 'Easy', 'Updated requirement', 'blob:local-cover']) assert.ok(html.includes(phrase), phrase);
  assert.doesNotMatch(html, /Preview placeholder|Ask directions|Draft theme/);
  html = renderToStaticMarkup(React.createElement(PracticeCardPreview, { title: '', setup: props.setup, requirements: [''] }));
  assert.match(html, /Your conversation theme/);
  assert.match(html, /Add requirements/);
});
test('teacher draft difficulty changes independently and creation forwards the fixed selection', async () => {
  // Exercise handlers with a small local hook runner, not a browser/DOM simulation.
  const original = Object.fromEntries(['useState', 'useRef', 'useMemo', 'useEffect'].map(key => [key, React[key]]));
  const states = []; let cursor = 0;
  React.useState = initial => {
    const at = cursor++;
    if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial;
    return [states[at], value => { states[at] = typeof value === 'function' ? value(states[at]) : value; }];
  };
  React.useRef = initial => React.useState({ current: initial })[0];
  React.useMemo = factory => React.useState(factory)[0];
  React.useEffect = () => {};
  const { LanguagePracticeClient } = require('../src/features/language-practice/language-practice-client.ts');
  const originalCreate = LanguagePracticeClient.prototype.createPractice;
  let submitted;
  LanguagePracticeClient.prototype.createPractice = async input => { submitted = input; };
  function render() { cursor = 0; return TeacherPracticesView(); }
  function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)]; }
  try {
    let tree = render();
    const selects = nodes(tree).filter(node => node.type === 'select');
    assert.equal(selects[2].props.value, 'medium');
    selects[0].props.onChange({ target: { value: 'B2' } });
    tree = render();
    nodes(tree).filter(node => node.type === 'select')[2].props.onChange({ target: { value: 'hard' } });
    tree = render();
    const updated = nodes(tree).filter(node => node.type === 'select');
    assert.deepEqual(updated.map(node => node.props.value), ['B2', 5, 'hard']);
    nodes(tree).find(node => node.type === 'input' && node.props.maxLength === 120).props.onChange({ target: { value: 'Travel plans' } });
    nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Ask directions' } });
    tree = render();
    const preview = nodes(tree).find(node => node.type.name === 'PracticeCardPreview');
    assert.deepEqual(preview.props.setup, { level: 'B2', durationMinutes: 5, difficulty: 'hard' });
    await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    assert.deepEqual(submitted.setup, { level: 'B2', durationMinutes: 5, difficulty: 'hard' });
  } finally {
    Object.assign(React, original);
    LanguagePracticeClient.prototype.createPractice = originalCreate;
  }
});
test('form source retains pending submission guard, error feedback, local preview cleanup and removal', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/teacher/TeacherPracticesView.tsx'), 'utf8');
  assert.match(source, /pending.current/);
  assert.match(source, /client.createPractice\(input, image/);
  assert.match(source, /validatePracticeImage/);
  assert.match(source, /URL.createObjectURL/); assert.match(source, /URL.revokeObjectURL/);
  assert.match(source, /Remove image/); assert.match(source, /role="alert"/);
  assert.match(source, /disabled=\{busy\}/);
});
