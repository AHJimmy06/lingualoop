const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const { PracticeScene, getPracticeScene } = require('../src/features/language-practice/PracticeScene.tsx');

test('each supported topic selects its own replaceable scene and unknown topics use everyday fallback', () => {
  const topics = ['travel', 'work', 'studies', 'everyday-conversation'];
  const scenes = topics.map(getPracticeScene);
  assert.deepEqual(scenes.map((scene) => scene.topic), topics);
  assert.equal(new Set(scenes.map((scene) => scene.image)).size, topics.length);
  assert.equal(getPracticeScene('not-a-topic').topic, 'everyday-conversation');
  assert.equal(getPracticeScene('not-a-topic').image, getPracticeScene('everyday-conversation').image);
});

test('scene presents two accessible participant figures and defaults both to neutral', () => {
  const scene = PracticeScene({ topic: 'studies' });
  const [background, stage, status] = scene.props.children;
  assert.equal(scene.props['aria-label'], 'Study conversation scene');
  assert.equal(background.props.alt, '');
  assert.equal(stage.type, 'div');
  assert.equal(status.props['aria-live'], 'polite');
  const figures = stage.props.children.map((figure) => figure.type(figure.props));
  assert.equal(figures.length, 2);
  assert.deepEqual(figures.map((figure) => figure.props['data-state']), ['idle', 'idle']);
  assert.ok(figures.every((figure) => figure.props.role === 'group' && figure.props['aria-label']));
});

test('scene reflects supplied participant presentation states without requiring event wiring', () => {
  const scene = PracticeScene({ topic: 'work', learnerState: 'speaking', partnerState: 'listening' });
  const figures = scene.props.children[1].props.children.map((figure) => figure.type(figure.props));
  assert.deepEqual(figures.map((figure) => figure.props['data-state']), ['speaking', 'listening']);
  assert.deepEqual(figures.map((figure) => figure.props['aria-label']), ['You — speaking', 'Conversation partner — listening']);
});
