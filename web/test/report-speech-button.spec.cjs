const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');

for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: filename }).outputText, filename);
const filename = path.join(__dirname, '../src/features/language-practice/ReportSpeechButton.tsx');
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const { reportAudioPlayback } = require('../src/features/language-practice/report-audio-playback.ts');
function wav() {
  const bytes = new Uint8Array(48);
  bytes.set(Buffer.from('RIFF'), 0); bytes.set(Buffer.from('WAVE'), 8);
  return new Blob([bytes], { type: 'audio/wav' });
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)];
}

function mount(t, props = { text: 'I would like to visit Peru.' }) {
  const originalLoad = Module._load;
  const originalAudio = globalThis.Audio;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let index = 0;
  const hooks = [], effects = [], calls = [], made = [], revoked = [], audios = [];
  let response = Promise.resolve({ ok: true, wav: wav() });
  let failPlay = false;
  const fakeReact = {
    ...React,
    useState(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = initial;
      return [hooks[slot], value => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; }];
    },
    useRef(initial) { const slot = index++; return hooks[slot] ||= { current: initial }; },
    useEffect(effect, deps) {
      const slot = index++;
      const previous = hooks[slot];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) effects.push(() => {
        previous?.cleanup?.();
        hooks[slot] = { deps, cleanup: effect() };
      });
    },
  };
  Module._load = function(request, parent, isMain) {
    if (request === 'react') return fakeReact;
    if (request === '../../auth-session' && parent.filename === filename) return { authSession: { synthesize: async (...args) => { calls.push(args); return response; } } };
    return originalLoad.call(this, request, parent, isMain);
  };
  class FakeAudio {
    constructor(src) { this.src = src; this.currentTime = 0; this.playCount = 0; this.pauseCount = 0; audios.push(this); }
    async play() { this.playCount++; if (failPlay) throw new Error('private playback detail'); }
    pause() { this.pauseCount++; this.onpause?.(); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
  }
  globalThis.Audio = FakeAudio;
  URL.createObjectURL = () => { const url = `blob:report-audio-${made.length}`; made.push(url); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  delete require.cache[filename];
  const { ReportSpeechButton } = require(filename);
  Module._load = originalLoad;
  const h = {
    props, calls, made, revoked, audios,
    response(value) { response = value; },
    failPlay(value) { failPlay = value; },
    render() { index = 0; const tree = ReportSpeechButton(h.props); effects.splice(0).forEach(effect => effect()); return tree; },
    button() { return nodes(h.render()).find(node => node.type === 'button'); },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
  t.after(() => {
    h.unmount();
    globalThis.Audio = originalAudio;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    Module._load = originalLoad;
  });
  h.render();
  return h;
}

test('report audio is explicit, local, replayable, stoppable and cleaned up on unmount', async t => {
  const h = mount(t);
  assert.deepEqual(h.calls, [], 'render never synthesizes or plays audio');
  h.button().props.onClick();
  await flush();
  assert.deepEqual(h.calls, [['en', h.props.text]]);
  assert.equal(h.audios[0].playCount, 1);
  assert.equal(h.button().props['aria-label'], 'Stop audio');
  assert.equal(h.button().props.title, 'Stop audio');
  h.button().props.onClick();
  assert.equal(h.button().props['aria-label'], 'Listen');
  assert.equal(h.button().props.title, 'Listen');
  h.button().props.onClick(); await flush();
  assert.equal(h.audios[0].playCount, 2);
  assert.equal(h.calls.length, 1, 'replay uses the existing safe Blob URL');
  h.audios[0].onended();
  assert.equal(h.button().props['aria-pressed'], false);
  h.unmount();
  assert.deepEqual(h.revoked, h.made);
  assert.equal(h.audios[0].src, '');
});

test('another report volume button stops the current sound immediately and clears its playing state', async t => {
  const h = mount(t);
  h.button().props.onClick(); await flush();
  assert.equal(h.button().props['aria-pressed'], true);
  const releaseOther = reportAudioPlayback.claim(() => {});
  t.after(releaseOther);
  assert.equal(h.audios[0].pauseCount, 1);
  assert.equal(h.audios[0].currentTime, 0);
  assert.equal(h.button().props['aria-pressed'], false);
  assert.equal(h.button().props.title, 'Listen');
  releaseOther();
  h.button().props.onClick(); await flush();
  assert.equal(h.calls.length, 1, 'previously generated audio remains reusable');
  h.audios[0].onended();
  assert.equal(h.button().props['aria-pressed'], false, 'replay events use the latest request generation');
});

test('superseded synthesis cannot play later when its request finishes out of order', async t => {
  const h = mount(t);
  let resolve;
  h.response(new Promise(done => { resolve = done; }));
  h.button().props.onClick();
  assert.equal(h.button().props['aria-busy'], true);
  const releaseOther = reportAudioPlayback.claim(() => {});
  t.after(releaseOther);
  assert.equal(h.button().props['aria-busy'], false);
  resolve({ ok: true, wav: wav() }); await flush();
  assert.deepEqual(h.made, []);
  assert.deepEqual(h.audios, []);
  assert.equal(h.button().props['aria-pressed'], false);
});

test('invalid, empty and overlong strings are disabled without truncation or requests', async t => {
  const h = mount(t, { text: '' });
  for (const text of ['', '   ', 'x'.repeat(501), 'hello\nworld']) {
    h.props = { text };
    assert.equal(h.button().props.disabled, true);
    h.button().props.onClick(); await flush();
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.made.length, 0);
});

test('duplicate clicks coalesce and late synthesis after a text change cannot play stale audio', async t => {
  const h = mount(t);
  let resolve;
  h.response(new Promise(done => { resolve = done; }));
  const button = h.button();
  button.props.onClick(); button.props.onClick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.button().props.disabled, true);
  h.props = { text: 'New text', language: 'es', label: 'Escuchar' };
  h.render();
  resolve({ ok: true, wav: wav() }); await flush();
  assert.equal(h.made.length, 0);
  assert.equal(h.button().props['aria-label'], 'Escuchar');
  assert.equal(h.button().props.title, 'Escuchar');
  assert.equal(h.button().props.children.props['aria-hidden'], 'true');
  h.response(Promise.resolve({ ok: true, wav: wav() }));
  h.button().props.onClick(); await flush();
  assert.deepEqual(h.calls[1], ['es', 'New text']);
});

test('synthesis failures and browser playback failures are accessible and never leak details', async t => {
  const h = mount(t);
  h.response(Promise.resolve({ ok: false, error: 'unauthorized' }));
  h.button().props.onClick(); await flush();
  assert.match(nodes(h.render()).find(node => node.props.role === 'status').props.children, /Sign in again/);
  assert.equal(h.button().props.disabled, false);
  h.response(Promise.resolve({ ok: true, wav: wav() }));
  h.failPlay(true);
  h.button().props.onClick(); await flush();
  const status = nodes(h.render()).find(node => node.props.role === 'status');
  assert.match(status.props.children, /could not be played/);
  assert.doesNotMatch(status.props.children, /private/);
  assert.deepEqual(h.revoked, h.made);
});

test('late synthesis after unmount and invalid WAV data allocate no audio resources', async t => {
  const h = mount(t);
  h.response(Promise.resolve({ ok: true, wav: new Blob(['not wav'], { type: 'audio/wav' }) }));
  h.button().props.onClick(); await flush();
  assert.equal(h.made.length, 0);
  let resolve;
  h.response(new Promise(done => { resolve = done; }));
  h.button().props.onClick();
  h.unmount();
  resolve({ ok: true, wav: wav() }); await flush();
  assert.equal(h.made.length, 0);
});
