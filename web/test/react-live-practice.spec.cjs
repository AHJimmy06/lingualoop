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

const { LiveTurnController } = require('../src/features/language-practice/react-live-turn.ts');
const { ResponseAudioUrls } = require('../src/features/language-practice/react-live-audio.ts');
const viewPath = path.join(__dirname, '../src/features/language-practice/LivePracticeView.tsx');
const routesPath = path.join(__dirname, '../src/react-routes.tsx');
const React = require('react');
const Module = require('node:module');

// Execute the view with deterministic hooks; no effects, media, timers or API calls.
function renderLiveSession(session, remainingMs = 60000) {
  const state = [session, false];
  let cursor = 0;
  let memoCursor = 0;
  const memo = [];
  const hooks = {
    ...React,
    useState(initial) {
      const at = cursor++;
      if (!(at in state)) state[at] = at === 13 ? { now: 0, anchor: { remainingMs, monotonicAt: 0 } } : initial;
      return [state[at], value => { state[at] = typeof value === 'function' ? value(state[at]) : value; }];
    },
    useMemo(factory) {
      const at = memoCursor++;
      if (!(at in memo)) memo[at] = factory();
      return memo[at];
    },
    useCallback: callback => callback,
    useRef: initial => ({ current: initial }),
    useEffect() {},
  };
  const module = new Module(viewPath);
  module.filename = viewPath;
  module.paths = Module._nodeModulePaths(path.dirname(viewPath));
  const originalRequire = module.require.bind(module);
  module.require = request => {
    if (request === 'react') return hooks;
    if (request === 'react-router-dom') return { useParams: () => ({ sessionId: 'session-a' }), useNavigate: () => () => {}, Link: 'a' };
    if (request === '../../auth-session') return { authSession: {} };
    if (request === './language-practice-client') return { LanguagePracticeClient: class {} };
    if (request === './PracticeScene') return { PracticeScene: 'PracticeScene' };
    if (request === './PracticeRecorder') return { PracticeRecorder: 'PracticeRecorder' };
    if (request.startsWith('../../components/ui/')) return Object.fromEntries(
      ['Button', 'Bubble', 'BubbleContent', 'Message', 'MessageContent', 'MessageGroup', 'MessageHeader'].map(name => [name, name]));
    return originalRequire(request);
  };
  module._compile(ts.transpileModule(fs.readFileSync(viewPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: viewPath,
  }).outputText, viewPath);
  return {
    render() { cursor = 0; memoCursor = 0; return module.exports.LivePracticeView(); },
    get controller() { return memo[1]; },
  };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)];
}
const session = { status: 'ACTIVE', topic: 'travel', level: 'A1', durationMinutes: 5,
  turns: [{ sequence: 1, transcript: 'learner '.repeat(100), assistantResponse: 'partner '.repeat(100) }] };

for (const [difficulty, label] of [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], [null, 'Difficulty not recorded'], [undefined, 'Difficulty not recorded']]) {
  test(`live session metadata shows recorded difficulty ${String(difficulty)} without a preference fallback`, () => {
    const snapshot = difficulty === undefined ? { ...session } : { ...session, difficulty };
    const all = nodes(renderLiveSession(snapshot).render());
    const details = all.find(node => node.props['aria-label'] === 'Session details');
    const field = nodes(details).find(node => node.type === 'p' && nodes(node).some(child => child.type === 'strong' && child.props.children === 'Task difficulty'));
    assert.ok(field, 'recorded difficulty has a read-only session metadata field');
    assert.equal(nodes(field).find(node => node.type === 'span').props.children, label);
    assert.equal(nodes(details).filter(node => node.type === 'select' || node.type === 'input' || node.type === 'button').length, 0);
    const view = fs.readFileSync(viewPath, 'utf8');
    assert.match(view, /difficultyLabel\(session\.difficulty\)/);
    assert.doesNotMatch(view, /readPreferences|savePreferences|PracticeSettingsDialog/);
  });
}

test('rendered conversation stacks on narrow screens and uses equal shrinkable wide tracks', () => {
  const tree = renderLiveSession(session).render();
  assert.match(tree.props.className, /\bauthenticated-page\b/);
  assert.doesNotMatch(tree.props.className, /max-w-3xl/);
  const all = nodes(tree);
  const grid = all.find(node => node.props.className?.includes('lg:grid-cols-'));
  assert.ok(grid, 'desktop split is present in the rendered session');
  assert.match(grid.props.className, /grid-cols-1/);
  assert.match(grid.props.className, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\]/);
  assert.doesNotMatch(grid.props.className, /(?:sm|md):grid-cols-|landscape:|24rem/);
  assert.match(grid.props.className, /items-start/);
  const children = React.Children.toArray(grid.props.children);
  assert.equal(children[0].props.children.type, 'PracticeScene');
  assert.equal(children[1].props['aria-labelledby'], 'conversation-title');
  assert.equal(children[2].props['aria-label'], 'Voice turn controls');
  assert.deepEqual(nodes(children[3]).filter(node => node.type === 'Button').map(node => node.props.children),
    ['Refresh session', 'Finish practice']);
  assert.doesNotMatch(grid.props.className, /overflow-hidden|overflow-y-auto|fixed/);
  assert.match(children[0].props.className, /lg:col-start-1.*lg:row-start-1.*lg:row-span-3/);
  assert.match(children[1].props.className, /min-w-0.*lg:col-start-2.*lg:row-start-1/);
  assert.doesNotMatch(children[1].props.className, /row-span-/);
  assert.match(children[2].props.className, /lg:col-start-2.*lg:row-start-2/);
  assert.match(children[3].props.className, /lg:col-start-2.*lg:row-start-3/);
  assert.ok(nodes(children[2]).some(node => node.props.children === 'When you are ready, record your response.'));
  for (const child of children) {
    assert.doesNotMatch(child.props.className, /(?:^|\s)(?:order-|(?:col|row)-start-)|(?:sm|md):(?:order-|(?:col|row)-start-)/);
    assert.doesNotMatch(nodes(child).map(node => node.props.className || '').join(' '), /overflow-y-auto|overflow-scroll/);
  }
  assert.ok(all.filter(node => node.type === 'MessageContent').every(node =>
    /min-w-0.*max-w-prose.*\[overflow-wrap:anywhere\]/.test(node.props.className)));
  assert.doesNotMatch(all.map(node => node.props.className || '').join(' '), /\bsticky\b|\bh-\[|\bmax-h-/);
  assert.equal(all.filter(node => node.type === 'PracticeRecorder').length, 1);
});

test('desktop practice grid receives the viewport remainder after normal-flow page content', () => {
  const tree = renderLiveSession(session).render();
  const classes = tree.props.className.split(/\s+/);
  assert.ok(classes.includes('min-h-svh'), 'the page supplies a viewport minimum, not a fixed height');
  assert.ok(classes.includes('lg:flex'), 'only desktop establishes the height-allocation flex container');
  assert.ok(classes.includes('lg:flex-col'));
  assert.ok(!classes.includes('flex') && !classes.includes('flex-col'), 'mobile keeps its default page layout');
  const children = React.Children.toArray(tree.props.children).flatMap(node =>
    node.type === React.Fragment ? React.Children.toArray(node.props.children) : [node]);
  assert.equal(children[0].type, 'header');
  assert.equal(children[1].props['aria-label'], 'Session details');
  const grid = children[2];
  assert.ok(grid.props.className.split(/\s+/).includes('lg:flex-1'), 'the grid grows into remaining space below header and metadata');
  assert.ok(!grid.props.className.split(/\s+/).includes('flex-1'), 'mobile does not allocate extra grid height');
  assert.match(grid.props.className, /lg:grid-rows-\[auto_auto_1fr\]/);
  assert.doesNotMatch(nodes(tree).map(node => node.props.className || '').join(' '),
    /(?:^|\s)(?:\S*:)?(?:h-|max-h-|min-h-\[|overflow-hidden|overflow-y-auto|overflow-scroll|absolute|fixed)|calc\(/);
});

test('desktop scene centers within its full three-row area without changing mobile alignment', () => {
  for (const turns of [[], session.turns, Array.from({ length: 20 }, (_, index) => ({ ...session.turns[0], sequence: index + 1 }))]) {
    const all = nodes(renderLiveSession({ ...session, turns }).render());
    const grid = all.find(node => node.props.className?.includes('lg:grid-cols-'));
    const children = React.Children.toArray(grid.props.children);
    const sceneClasses = children[0].props.className.split(/\s+/);
    assert.ok(sceneClasses.includes('lg:self-center'), 'scene alignment is centered only on desktop');
    assert.ok(sceneClasses.includes('lg:row-span-3'), 'center uses the complete right-column practice area');
    assert.ok(!sceneClasses.includes('self-center'), 'mobile scene alignment remains unchanged');
    assert.ok(grid.props.className.split(/\s+/).includes('items-start'), 'other grid children retain top alignment');
    assert.equal(all.filter(node => node.type === 'PracticeScene').length, 1);
    assert.equal(children[0].props.children.type, 'PracticeScene');
    assert.equal(children[1].props['aria-labelledby'], 'conversation-title');
    assert.equal(children[2].props['aria-label'], 'Voice turn controls');
    assert.deepEqual(nodes(children[3]).filter(node => node.type === 'Button').map(node => node.props.children),
      ['Refresh session', 'Finish practice']);
  }
});

test('split retains one recorder, chronology and busy/expired finish guards', () => {
  const h = renderLiveSession(session);
  let all = nodes(h.render());
  const recorder = all.find(node => node.type === 'PracticeRecorder');
  assert.equal(recorder.key, '.$session-a'); // React.Children.toArray prefixes the element key.
  assert.equal(recorder.props.disabled, false);
  recorder.props.onBusyChange(true);
  all = nodes(h.render());
  assert.equal(all.filter(node => node.type === 'PracticeRecorder').length, 1);
  assert.equal(all.find(node => node.props.children === 'Finish practice').props.disabled, true);
  assert.deepEqual(all.filter(node => node.type === 'BubbleContent').map(node => node.props.children),
    [session.turns[0].transcript, session.turns[0].assistantResponse]);
  h.controller.record(new Blob(['voice']), true);
  const pending = nodes(h.render());
  assert.equal(pending.filter(node => node.type === 'PracticeRecorder').length, 0);
  assert.equal(pending.find(node => node.props.children === 'Check for response').props.disabled, false);
  assert.equal(pending.find(node => node.props.children === 'Refresh session').props.disabled, true);
  assert.equal(pending.find(node => node.props.children === 'Finish practice').props.disabled, true);
  const unavailable = nodes(renderLiveSession(null).render());
  assert.equal(unavailable.filter(node => node.type === 'PracticeRecorder').length, 0);
  assert.ok(unavailable.some(node => node.props.role === 'alert'));
  const expired = nodes(renderLiveSession({ ...session, status: 'EXPIRED' }, 0).render());
  assert.equal(expired.find(node => node.type === 'PracticeRecorder').props.disabled, true);
  assert.equal(expired.find(node => node.props.children === 'Finish practice').props.disabled, true);
});

test('processing and transport uncertainty preserve one pending recording and ID for manual checks', async () => {
  let nextId = 0;
  const controller = new LiveTurnController(() => `turn-${++nextId}`);
  const blob = new Blob(['voice'], { type: 'audio/webm' });
  const pending = controller.record(blob, true);
  assert.equal(pending.clientTurnId, 'turn-1');
  const calls = [];
  const send = async (sessionId, submittedBlob, id) => {
    calls.push({ sessionId, submittedBlob, id });
    return calls.length === 1 ? { status: 'PROCESSING' } : Promise.reject(new Error('network lost'));
  };

  assert.equal((await controller.check('session-a', send)).kind, 'processing');
  assert.equal(controller.pending, pending);
  assert.equal(controller.canRecord(true), false);
  assert.equal((await controller.check('session-a', send)).kind, 'uncertain');
  assert.equal(controller.pending, pending);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.sessionId === 'session-a' && call.submittedBlob === blob && call.id === pending.clientTurnId));
  assert.equal(controller.submitting, false);
});

test('completed and failed terminal results release the pending turn while errors remain uncertain', async () => {
  for (const status of ['COMPLETED', 'FAILED']) {
    const controller = new LiveTurnController(() => 'stable-turn-id');
    controller.record(new Blob(['voice'], { type: 'audio/webm' }), true);
    const result = await controller.check('session-a', async () => ({ status }));
    assert.equal(result.kind, status.toLowerCase());
    assert.equal(controller.pending, null);
    assert.equal(controller.canRecord(true), true);
  }
});

test('response audio attempts autoplay, exposes fallback replay, and revokes URLs on replace and clear', async () => {
  let nextUrl = 0;
  const revoked = [];
  const urls = new ResponseAudioUrls({
    createObjectURL: () => `blob:response-${++nextUrl}`,
    revokeObjectURL: (url) => revoked.push(url),
  });
  assert.equal(urls.replace({ audioBase64: 'AQID', audioMimeType: 'audio/wav' }), 'blob:response-1');
  assert.equal(await urls.autoplay(async () => { throw new Error('blocked'); }), false);
  assert.equal(urls.manualReplayRequired, true);
  assert.equal(await urls.replay(async () => {}), true);
  assert.equal(urls.manualReplayRequired, false);
  assert.equal(urls.replace({ audioBase64: 'BAUG', audioMimeType: 'audio/wav' }), 'blob:response-2');
  assert.deepEqual(revoked, ['blob:response-1']);
  assert.equal(urls.replace({ audioBase64: null, audioMimeType: null }), null);
  assert.deepEqual(revoked, ['blob:response-1', 'blob:response-2']);
  urls.clear();
  assert.deepEqual(revoked, ['blob:response-1', 'blob:response-2']);
});

test('recorder is remounted per session and stale recorded callbacks cannot submit', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  assert.ok(view.includes('{!turnController.pending && <PracticeRecorder key={sessionId} disabled={!active} onRecorded={onRecorded} onBusyChange={onRecorderBusyChange} onRecordingChange={onRecordingChange} />}'));
  assert.equal((view.match(/<PracticeRecorder\b/g) || []).length, 1);
  const callback = view.match(/const onRecorded = \(blob: Blob\) => \{([\s\S]*?)\n  \};/);
  assert.ok(callback, 'onRecorded callback should exist');
  assert.match(callback[1], /sessionIdRef\.current !== sessionId/);
  assert.ok(callback[1].indexOf('sessionIdRef.current !== sessionId') < callback[1].indexOf('turnController.record('),
    'stale callbacks must return before recording or checking a turn');
});

test('live practice finishes explicitly, preserves pending and recorder guards, and keeps partner replay compact', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  assert.match(view, /client\.finishSession\(requestedSessionId\)/);
  assert.match(view, /finishing/);
  assert.match(view, /onBusyChange/);
  assert.match(view, /disabled=\{[^}]*finishing[^}]*recorderBusy|disabled=\{[^}]*recorderBusy[^}]*finishing/);
  assert.match(view, /title="Replay response"/);
  assert.match(view, /aria-label="Replay response"/);
  assert.doesNotMatch(view, /controls preload="none"/);
  assert.doesNotMatch(view, /Use the replay button or audio controls|audio player controls/);
  assert.doesNotMatch(view, /Record up to 20 seconds\. If the result is uncertain, checking again reuses the exact recording and turn ID\.|Ready to record|Press Space when no interactive control is focused\. Maximum 20 seconds\.|Turn completed and saved\.|Your response is ready\.|Time is up\. Checking the session status before opening its report/);
  assert.match(view, /setTurnStatus\(''\);\s*const nextUrl = audioController\.current\.replace\(response\)/);
  assert.match(view, /align="end"[\s\S]*?<MessageHeader>You/);
  assert.match(view, /align="start"[\s\S]*?<MessageHeader>Conversation partner/);
});

test('live route renders shadcn left/right message bubbles and standalone recording controls', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  const routes = fs.readFileSync(routesPath, 'utf8');
  assert.match(routes, /<Route path="\/language-practice\/sessions\/:sessionId" element=\{\s*<RouteGate><LivePracticeView \/><\/RouteGate>/);
  assert.match(view, /<Message[^>]*align="start"/);
  assert.match(view, /<Message[^>]*align="end"/);
  assert.match(view, /<BubbleContent/);
  assert.match(view, /<PracticeRecorder/);
  assert.match(view, /Check for response/);
  assert.match(view, /aria-label="Replay response"/);
  assert.doesNotMatch(view, /turn-notice|<textarea|<input[^>]+text/i);
});
