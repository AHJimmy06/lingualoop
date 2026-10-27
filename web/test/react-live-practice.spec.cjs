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
  const effects = [];
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
    useEffect(effect, deps) { effects.push({ effect, deps }); },
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
    if (request === './SessionPracticeImage') return { SessionPracticeImage: 'SessionPracticeImage' };
    if (request === './PracticeRecorder') return { PracticeRecorder: 'PracticeRecorder' };
    if (request.startsWith('../../components/ui/')) return Object.fromEntries(
      ['Button', 'Bubble', 'BubbleContent', 'Message', 'MessageContent', 'MessageGroup', 'MessageHeader'].map(name => [name, name]));
    return originalRequire(request);
  };
  module._compile(ts.transpileModule(fs.readFileSync(viewPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: viewPath,
  }).outputText, viewPath);
  return {
    render() { cursor = 0; memoCursor = 0; effects.length = 0; return module.exports.LivePracticeView(); },
    get controller() { return memo[1]; },
    get effects() { return effects; },
    setSession(value) { state[0] = value; },
  };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes), ...(tree.type === 'PracticeRecorder' ? nodes(tree.props.actions) : [])];
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
  const grid = all.find(node => node.props.className?.includes('md:grid-cols-'));
  assert.ok(grid, 'desktop split is present in the rendered session');
  assert.match(grid.props.className, /grid-cols-1/);
  assert.match(grid.props.className, /md:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\]/);
  assert.doesNotMatch(grid.props.className, /sm:grid-cols-|landscape:|24rem/);
  assert.match(grid.props.className, /items-start/);
  const children = React.Children.toArray(grid.props.children);
  assert.equal(children[0].props.children.type, 'SessionPracticeImage');
  assert.equal(children[1].props['aria-labelledby'], 'conversation-title');
  assert.ok(nodes(children[1]).some(node => node.props['aria-label'] === 'Voice turn controls'), 'voice controls belong to conversation panel');
  assert.deepEqual(nodes(children[1]).filter(node => ['Refresh session', 'Finish practice'].includes(node.props['aria-label'])).map(node => node.props['aria-label']), ['Refresh session', 'Finish practice']);
  assert.equal(children.length, 2, 'there is no external actions row');
  assert.doesNotMatch(grid.props.className, /overflow-hidden|overflow-y-auto|fixed/);
  assert.match(children[0].props.className, /md:h-\[var\(--live-panel-height\)\]/);
  assert.match(children[1].props.className, /min-w-0.*md:col-start-2.*md:row-start-1/);
  assert.doesNotMatch(children[1].props.className, /row-span-/);
  assert.ok(!nodes(children[1]).some(node => node.type === 'p' && node.props.children === 'When you are ready, record your response.'));
  for (const child of children) {
    assert.doesNotMatch(child.props.className, /(?:^|\s)(?:order-|(?:col|row)-start-)|sm:(?:order-|(?:col|row)-start-)/);
    if (child !== children[1]) assert.doesNotMatch(nodes(child).map(node => node.props.className || '').join(' '), /overflow-y-auto|overflow-scroll/);
  }
  assert.ok(all.filter(node => node.type === 'MessageContent').every(node =>
    /min-w-0.*max-w-prose.*\[overflow-wrap:anywhere\]/.test(node.props.className)));
  const history = all.find(node => node.type === 'ol');
  assert.match(history.props.className, /min-h-0.*flex-1.*overflow-y-auto.*overscroll-contain/);
  assert.equal(history.props.tabIndex, 0);
  assert.ok(!nodes(history).some(node => node.props['aria-label'] === 'Voice turn controls'), 'controls stay outside scrolling messages');
  assert.match(children[1].props.className, /h-\[clamp\(18rem,45svh,32rem\)\]/);
  assert.doesNotMatch(all.map(node => node.props.className || '').join(' '), /\bsticky\b/);
  assert.equal(all.filter(node => node.type === 'PracticeRecorder').length, 1);
});

test('desktop centers both panels together in the remaining viewport space', () => {
  const tree = renderLiveSession(session).render();
  const classes = tree.props.className.split(/\s+/);
  assert.ok(classes.includes('min-h-svh'), 'the page supplies a viewport minimum, not a fixed height');
  assert.ok(classes.includes('md:flex'), 'only desktop establishes the height-allocation flex container');
  assert.ok(classes.includes('md:flex-col'));
  assert.ok(!classes.includes('flex') && !classes.includes('flex-col'), 'mobile keeps its default page layout');
  const children = React.Children.toArray(tree.props.children).flatMap(node =>
    node.type === React.Fragment ? React.Children.toArray(node.props.children) : [node]);
  assert.equal(children[0].type, 'header');
  assert.equal(children[1].props['aria-label'], 'Session details');
  const grid = children[2];
  assert.ok(grid.props.className.split(/\s+/).includes('md:flex-1'), 'the pair uses remaining desktop space');
  assert.ok(grid.props.className.split(/\s+/).includes('md:content-center'), 'center the pair, not the scene alone');
  assert.ok(!grid.props.className.split(/\s+/).includes('flex-1'), 'mobile does not allocate extra grid height');
  assert.doesNotMatch(grid.props.className, /grid-rows-/);
  assert.doesNotMatch([tree, grid].map(node => node.props.className || '').join(' '),
    /(?:^|\s)(?:\S*:)?(?:h-|max-h-|min-h-\[|overflow-hidden|overflow-y-auto|overflow-scroll|absolute|fixed)|calc\(/);
});

test('desktop scene matches conversation height and top alignment with empty or long history', () => {
  for (const turns of [[], session.turns, Array.from({ length: 20 }, (_, index) => ({ ...session.turns[0], sequence: index + 1 }))]) {
    const all = nodes(renderLiveSession({ ...session, turns }).render());
    const grid = all.find(node => node.props.className?.includes('md:grid-cols-'));
    const children = React.Children.toArray(grid.props.children);
    const sceneClasses = children[0].props.className.split(/\s+/);
    assert.ok(sceneClasses.includes('md:h-[var(--live-panel-height)]'), 'scene matches the conversation height');
    assert.ok(sceneClasses.includes('md:[&>section]:h-full'));
    assert.ok(sceneClasses.includes('md:[&>section>div]:min-h-0'));
    assert.ok(!sceneClasses.includes('md:self-center'), 'scene cannot be vertically offset');
    assert.ok(!sceneClasses.includes('self-center'), 'mobile scene alignment remains unchanged');
    assert.ok(grid.props.className.split(/\s+/).includes('items-start'), 'other grid children retain top alignment');
    assert.equal(all.filter(node => node.type === 'SessionPracticeImage').length, 1);
    assert.equal(children[0].props.children.type, 'SessionPracticeImage');
    assert.equal(children[1].props['aria-labelledby'], 'conversation-title');
    assert.match(children[1].props.className, /h-\[clamp\(18rem,45svh,32rem\)\]/);
    const history = nodes(children[1]).find(node => node.type === 'ol');
    if (turns.length) assert.match(history.props.className, /overflow-y-auto/);
    assert.doesNotMatch(children[0].props.className, /overflow-y-auto/);
    assert.ok(nodes(children[1]).some(node => node.props['aria-label'] === 'Voice turn controls'), 'voice controls belong to conversation panel');
    assert.deepEqual(nodes(children[1]).filter(node => ['Refresh session', 'Finish practice', 'Exit practice'].includes(node.props['aria-label'])).map(node => node.props['aria-label']), ['Refresh session', turns.length ? 'Finish practice' : 'Exit practice']);
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
  assert.equal(all.find(node => node.props['aria-label'] === 'Finish practice').props.disabled, true);
  assert.deepEqual(all.filter(node => node.type === 'BubbleContent').map(node => node.props.children),
    [session.turns[0].transcript, session.turns[0].assistantResponse]);
  h.controller.record(new Blob(['voice']), true);
  const pending = nodes(h.render());
  assert.equal(pending.filter(node => node.type === 'PracticeRecorder').length, 0);
  assert.equal(pending.find(node => node.props.children === 'Check for response').props.disabled, false);
  assert.equal(pending.find(node => node.props['aria-label'] === 'Refresh session').props.disabled, true);
  assert.equal(pending.find(node => node.props['aria-label'] === 'Finish practice').props.disabled, true);
  const unavailable = nodes(renderLiveSession(null).render());
  assert.equal(unavailable.filter(node => node.type === 'PracticeRecorder').length, 0);
  assert.ok(unavailable.some(node => node.props.role === 'alert'));
  const expired = nodes(renderLiveSession({ ...session, status: 'EXPIRED' }, 0).render());
  assert.equal(expired.find(node => node.type === 'PracticeRecorder').props.disabled, true);
  assert.equal(expired.find(node => node.props['aria-label'] === 'Finish practice').props.disabled, true);
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
  assert.ok(view.includes('{!turnController.pending && <PracticeRecorder key={sessionId} disabled={!active || finishing} onRecorded={onRecorded} onBusyChange={onRecorderBusyChange} onRecordingChange={onRecordingChange} actions={sessionActions} />}'));
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
  assert.doesNotMatch(view, /Your response is being prepared\. You can check again shortly; no new recording is needed\.|We could not confirm your response yet\. Check again before recording another\.|Time is up, but your response is still being prepared/);
  assert.match(view, /turnStatus && !turnController\.pending/);
  assert.match(view, /setTurnStatus\(''\);\s*const nextUrl = audioController\.current\.replace\(response\)/);
  assert.match(view, /align="end"[\s\S]*?<MessageHeader>You/);
  assert.match(view, /align="start"[\s\S]*?<MessageHeader>Conversation partner/);
});

test('live route renders shadcn left/right message bubbles and recording controls inside conversation panel', () => {
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

test('conversation follows newest turn and updated reply by scrolling only the inner history', () => {
  const h = renderLiveSession(session);
  const history = { scrollTop: 0, scrollHeight: 1200 };
  let lastDeps;
  function commit() {
    const tree = h.render();
    const list = nodes(tree).find(node => node.type === 'ol');
    if (list) list.props.ref.current = history;
    const scroll = h.effects.find(item => item.deps?.length === 4 && item.deps[0] === 'session-a');
    assert.ok(scroll, 'follow effect depends on the latest content, not the timer');
    if (!lastDeps || scroll.deps.some((value, i) => value !== lastDeps[i])) scroll.effect();
    lastDeps = scroll.deps;
  }
  commit(); assert.equal(history.scrollTop, 1200, 'initial conversation opens at newest turn');
  history.scrollTop = 100;
  commit(); assert.equal(history.scrollTop, 100, 'unrelated renders do not prevent reading older messages');
  const next = { ...session, turns: [...session.turns, { sequence: 2, transcript: 'New message', assistantResponse: '' }] };
  h.setSession(next); history.scrollHeight = 1500;
  commit(); assert.equal(history.scrollTop, 1500);
  h.setSession({ ...next, turns: [next.turns[0], { ...next.turns[1], assistantResponse: 'New partner response' }] });
  history.scrollHeight = 1800; commit(); assert.equal(history.scrollTop, 1800, 'reply update follows even if turn count is unchanged');
  h.setSession({ ...session, turns: [] }); commit();
  const source = fs.readFileSync(viewPath, 'utf8');
  assert.doesNotMatch(source, /scrollIntoView|window\.scrollTo|history\.focus/);
});

test('conversation guidance is an accessible heading info tooltip instead of a message placeholder', () => {
  const all = nodes(renderLiveSession({ ...session, turns: [] }).render());
  const hint = all.find(node => node.props.role === 'tooltip');
  assert.ok(hint);
  assert.equal(hint.props.children, 'Your completed conversation turns will appear here.');
  assert.match(hint.props.className, /group-hover:block.*group-focus-within:block/);
  const trigger = all.find(node => node.props['aria-label'] === 'About conversation history');
  assert.equal(trigger.props['aria-describedby'], hint.props.id);
  assert.equal(all.some(node => node.type === 'p' && node.props.children === hint.props.children), false);
  const history = all.find(node => node.type === 'ol');
  assert.ok(history.props.ref, 'empty conversations keep the same scrolling container');
});

test('live practice uses compact vertical padding without changing shared authenticated pages', () => {
  const tree = renderLiveSession(session).render();
  assert.match(tree.props.className, /live-practice-page/);
  const css = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');
  assert.match(css, /\.live-practice-page\s*\{\s*padding-block: 0\.75rem;/);
  const all = nodes(tree);
  assert.match(all.find(node => node.type === 'header').props.className, /mb-3.*sm:mb-4/);
  assert.match(all.find(node => node.props['aria-label'] === 'Session details').props.className, /mb-3/);
});

test('refresh and finish are icon actions in the recorder row with accessible tooltips', () => {
  const all = nodes(renderLiveSession(session).render());
  const recorder = all.find(node => node.type === 'PracticeRecorder');
  assert.ok(recorder.props.actions);
  for (const label of ['Refresh session', 'Finish practice']) {
    const button = all.find(node => node.type === 'Button' && node.props['aria-label'] === label);
    assert.equal(nodes(button).some(node => node.type === 'svg'), true);
    const tooltip = all.find(node => node.props.id === button.props['aria-describedby']);
    assert.equal(tooltip.props.role, 'tooltip');assert.equal(tooltip.props.children, label);
  }
  const recorderSource = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/PracticeRecorder.tsx'), 'utf8');
  assert.match(recorderSource, /flex w-full items-center justify-center gap-2/);
  assert.match(recorderSource, /<\/Button>[\s\S]*?<\/div>\s*\{actions\}/);
});

test('desktop panels share a viewport-based height while mobile remains vertically stacked', () => {
  const all = nodes(renderLiveSession(session).render());
  const grid = all.find(node => node.props.className?.includes('md:grid-cols-'));
  const children = React.Children.toArray(grid.props.children);
  for (const child of children) assert.ok(child.props.className.includes('md:h-[var(--live-panel-height)]'));
  const css = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');
  assert.ok(css.includes('--live-panel-height: clamp(18rem, calc(100svh - 10rem), 56rem)'));
  assert.match(grid.props.className, /grid-cols-1/);
  assert.doesNotMatch(grid.props.className, /(?:^|\s)content-center(?:\s|$)/);
});
test('independent mode labels a manual single response without a conversation countdown', () => {
  const all = nodes(renderLiveSession({ ...session, turns: [], activity: { mode: 'single-response', aiRole: 'A friend', location: 'A wooded park' }, conversationTheme: 'Compare the photographs', parameters: [{ id: 'goal', requirement: 'Explain what the friends might enjoy.' }] }).render());
  assert.equal(all.find(node => node.type === 'h1').props.children, 'Your independent response');
  assert.equal(all.filter(node => node.props.role === 'timer').length, 0);
  assert.ok(all.some(node => node.type === 'strong' && node.props.children === 'Recording safety limit'));
  assert.ok(all.some(node => node.type === 'h2' && node.props.children === 'Your submitted response'));
  assert.ok(all.some(node => node.type === 'li' && node.props.children === 'Explain what the friends might enjoy.'));
});


test('student live sessions do not render teacher-only role or setting in either mode', () => {
  for (const mode of ['conversation', 'single-response']) {
    const tree = renderLiveSession({ ...session, activity: { mode, aiRole: 'Teacher-only role', location: 'Teacher-only location' } }).render();
    const all = nodes(tree);
    assert.ok(!all.some(node => node.type === 'strong' && ['AI role:', 'Setting:'].includes(node.props.children)));
    assert.doesNotMatch(JSON.stringify(tree), /Teacher-only role|Teacher-only location/);
  }
});


test('requirements open from a right-aligned icon in the conversation header instead of a permanent context block', () => {
  const custom = { ...session, activity: { mode: 'conversation', aiRole: 'Private role', location: 'Private setting' }, conversationTheme: 'A walk in the park', parameters: [{ id: 'goal', requirement: 'Give one reason.' }] };
  const all = nodes(renderLiveSession(custom).render());
  assert.ok(!all.some(n => n.props['aria-label'] === 'Activity context'));
  const title = all.find(n => n.props.id === 'conversation-title');
  const header = all.find(n => React.Children.toArray(n.props.children).some(child => child.props?.id === title.props.id));
  assert.ok(header, 'requirements action shares the conversation heading row');
  const action = nodes(header).find(n => n.props['aria-label'] === 'Requirements');
  assert.ok(action);
  assert.equal(action.props['aria-describedby'], 'requirements-tooltip');
  assert.ok(nodes(header).some(n => n.props.className === 'ml-auto shrink-0'));
  assert.ok(nodes(header).some(n => n.props.role === 'tooltip' && n.props.children === 'Requirements'));
  assert.ok(all.some(n => n.props.children === 'Activity instructions'));
  assert.ok(all.some(n => n.props.children === 'Give one reason.'));
  assert.ok(all.some(n => n.props['aria-label'] === 'Close activity instructions'));
  assert.doesNotMatch(JSON.stringify(all), /Private role|Private setting/);
});


test('empty session offers exit and routes discarded responses to catalogue without a report', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  assert.match(view, /session\?\.turns.length === 0 \? 'Exit practice' : 'Finish practice'/);
  assert.match(view, /result.status === 'DISCARDED'[\s\S]*?navigate\('\/language-practice', \{ replace: true \}\);\s*return;/);
  assert.match(view, /Exit practice — discard without a report/);
});
