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

function participants(scene) {
  return scene.props.children[1].props.children.map((figure) => figure.type(figure.props));
}

function figureImage(participant) {
  return participant.props.children.find((child) => child && child.type === 'img');
}

test('each supported topic selects its own replaceable scene and unknown topics use everyday fallback', () => {
  const topics = ['travel', 'work', 'studies', 'everyday-conversation'];
  const scenes = topics.map(getPracticeScene);
  assert.deepEqual(scenes.map((scene) => scene.topic), topics);
  assert.equal(new Set(scenes.map((scene) => scene.image)).size, topics.length);
  for (const scene of scenes) {
    const file = require('node:path').join(__dirname, '../public', scene.image);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
    assert.ok(bytes.length < 1_000_000, 'backgrounds should be optimized for the web');
  }
  assert.equal(getPracticeScene('not-a-topic').topic, 'everyday-conversation');
  assert.equal(getPracticeScene('not-a-topic').image, getPracticeScene('everyday-conversation').image);
});

test('wide scene keeps a substantial stage with filling artwork and minimal padding', () => {
  const scene = PracticeScene({ topic: 'travel' });
  const [background, stage] = scene.props.children;
  assert.match(background.props.className, /\bobject-cover\b/);
  assert.doesNotMatch(background.props.className, /object-contain|object-fill/);
  assert.doesNotMatch(scene.props.className, /(?:^|\s)(?:border(?:-\S+)?|bg-\S+|p[trblxy]?-\S+)(?:\s|$)/);
  const padding = stage.props.className.split(/\s+/).filter(token => /(?:^|:)p[trblxy]?-/.test(token));
  assert.deepEqual(padding, ['px-2', 'pt-2'], 'stage padding is at most eight pixels without responsive inflation');
  assert.doesNotMatch(stage.props.className, /bg-|from-|via-|to-|(?:^|:)gap-(?:6|8|12)/);
  assert.match(stage.props.className, /min-h-52/);
  assert.match(stage.props.className, /sm:min-h-64/);
  assert.match(stage.props.className, /lg:min-h-\[clamp\(20rem,45svh,36rem\)\]/);
  assert.doesNotMatch(stage.props.className, /\bh-screen\b|\bh-svh\b|\bfixed\b|\bmax-h-/);
  for (const figure of participants(scene)) {
    const image = figureImage(figure);
    assert.match(image.props.className, /object-contain/);
    assert.match(image.props.className, /lg:h-\[clamp\(10rem,24svh,20rem\)\]/);
    assert.match(image.props.className, /lg:w-full/);
  }
});

test('scene presents partner left and learner right with accessible neutral figures', () => {
  const scene = PracticeScene({ topic: 'studies' });
  const [background, stage, status] = scene.props.children;
  assert.equal(scene.props['aria-label'], 'Study conversation scene');
  assert.equal(background.props.src, '/images/scenes/studies-scene.webp');
  assert.equal(background.props.alt, '');
  assert.equal(background.props['aria-hidden'], 'true');
  assert.equal(stage.type, 'div');
  assert.match(stage.props.className, /flex /);
  assert.doesNotMatch(stage.props.className, /flex-row-reverse/);
  assert.equal(status.props['aria-live'], 'polite');
  assert.equal(status.props.children.join(''), 'You are quiet; conversation partner is quiet.');
  const figures = participants(scene);
  assert.equal(figures.length, 2);
  assert.deepEqual(figures.map((figure) => figure.props['data-state']), ['idle', 'idle']);
  assert.deepEqual(figures.map((figure) => figure.props['aria-label']), ['Conversation partner — idle', 'You — idle']);
  assert.deepEqual(figures.map((figure) => figure.props.children[2].props.children), ['Conversation partner', 'You']);
  assert.ok(figures.every((figure) => figure.props.role === 'group'));
  assert.deepEqual(figures.map((figure) => figureImage(figure).props.src), [
    '/images/scenes/partner-figure.svg', '/images/scenes/learner-figure.svg',
  ]);
  for (const figure of figures) {
    const image = figureImage(figure);
    assert.equal(image.props.alt, '');
    assert.equal(image.props['aria-hidden'], 'true');
    assert.match(image.props.className, /h-24 w-24 object-contain sm:h-32 sm:w-32/);
    assert.match(image.props.className, /motion-safe:transition-transform motion-reduce:transition-none/);
    assert.doesNotMatch(image.props.className, /-translate-y-1/);
    assert.deepEqual(figure.props.children[0].props.children, [false, false]);
  }
});

for (const [learnerState, partnerState, expectedStates] of [
  ['speaking', 'listening', ['listening', 'speaking']],
  ['listening', 'speaking', ['speaking', 'listening']],
]) {
  test(`${learnerState} learner and ${partnerState} partner keep role-bound states and motion treatments`, () => {
    const scene = PracticeScene({ topic: 'work', learnerState, partnerState });
    const figures = participants(scene);
    assert.deepEqual(figures.map((figure) => figure.props['data-state']), expectedStates);
    assert.deepEqual(figures.map((figure) => figure.props['aria-label']), [
      `Conversation partner — ${partnerState}`, `You — ${learnerState}`,
    ]);
    assert.deepEqual(figures.map((figure) => figureImage(figure).props.src), [
      '/images/scenes/partner-figure.svg', '/images/scenes/learner-figure.svg',
    ]);
    assert.equal(scene.props.children[2].props.children.join(''), `You are ${learnerState}; conversation partner is ${partnerState}.`);
    for (const figure of figures) {
      const speaking = figure.props['data-state'] === 'speaking';
      const indicator = figure.props.children[0].props.children.filter(Boolean)[0];
      assert.equal(indicator.props['aria-hidden'], 'true');
      assert.equal(indicator.props.children, speaking ? '••• )))' : '◖ Listening');
      if (speaking) {
        assert.match(indicator.props.className, /motion-safe:animate-pulse/);
        assert.match(figureImage(figure).props.className, /-translate-y-1/);
      } else {
        assert.doesNotMatch(indicator.props.className, /animate-pulse/);
        assert.doesNotMatch(figureImage(figure).props.className, /-translate-y-1/);
      }
      assert.match(figureImage(figure).props.className, /motion-reduce:transition-none/);
    }
  });
}

test('reserved normal-flow status slots keep idle and active participant geometry stable across topics', () => {
  for (const topic of ['travel', 'work', 'studies', 'everyday-conversation']) {
    const idleScene = PracticeScene({ topic });
    const idleFigures = participants(idleScene);
    for (const [learnerState, partnerState] of [['speaking', 'listening'], ['listening', 'speaking']]) {
      const activeScene = PracticeScene({ topic, learnerState, partnerState });
      assert.equal(activeScene.props.className, idleScene.props.className);
      assert.equal(activeScene.props.children[1].props.className, idleScene.props.children[1].props.className);
      participants(activeScene).forEach((figure, index) => {
        const idle = idleFigures[index];
        assert.equal(figure.props.className, idle.props.className);
        assert.deepEqual(figure.props.children.map((child) => child.type), ['div', 'img', 'span', 'span']);
        assert.deepEqual(idle.props.children.map((child) => child.type), ['div', 'img', 'span', 'span']);
        const slot = figure.props.children[0];
        assert.equal(slot.props.className, idle.props.children[0].props.className);
        assert.match(slot.props.className, /\bh-10\b/);
        assert.match(slot.props.className, /\bsm:h-12\b/);
        assert.match(slot.props.className, /\bshrink-0\b/);
        assert.match(slot.props.className, /\bflex\b.*\bitems-start\b.*\bjustify-center\b/);
        assert.doesNotMatch(slot.props.className, /absolute|fixed|overflow-hidden/);
        for (const indicator of slot.props.children.filter(Boolean)) {
          assert.doesNotMatch(indicator.props.className, /absolute|fixed|bottom-|top-|translate/);
          assert.match(indicator.props.className, /\bwhitespace-nowrap\b/);
        }
        assert.deepEqual(figure.props.children[2], idle.props.children[2]);
        assert.equal(figureImage(figure).props.className.replace(' -translate-y-1', '').trimEnd(), figureImage(idle).props.className.trimEnd());
      });
    }
  }
});

test('local partner asset identifies a robot teacher and retains the illustration viewport', () => {
  const asset = fs.readFileSync(require.resolve('../public/images/scenes/partner-figure.svg'), 'utf8');
  assert.match(asset, /viewBox="0 0 160 200"/);
  assert.match(asset, /<title[^>]*>Robot teacher<\/title>/);
  assert.doesNotMatch(asset, /<(?:script|image)\b|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
});
