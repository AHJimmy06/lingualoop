const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, filename);

test('manual stop sends one long recording; silence never submits and a later turn requires explicit start', async t => {
  const savedLoad = Module._load;
  const savedGlobals = Object.fromEntries(['navigator', 'window', 'MediaRecorder', 'performance', 'setInterval', 'clearInterval'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let index = 0, time = 0, microphones = 0;
  const hooks = [], effects = [], monitors = [], recordings = [], finalEvents = [];
  let trackStops = 0;
  const changed = (old, deps) => !old || deps.some((value, i) => value !== old.deps[i]);
  const fakeReact = {
    ...React,
    useState(initial) { const slot = index++; if (!(slot in hooks)) hooks[slot] = initial; return [hooks[slot], value => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; }]; },
    useRef(initial) { const slot = index++; return hooks[slot] ||= { current: initial }; },
    useCallback(fn, deps) { const slot = index++; if (changed(hooks[slot], deps)) hooks[slot] = { deps, fn }; return hooks[slot].fn; },
    useEffect(effect, deps) { const slot = index++; if (changed(hooks[slot], deps)) effects.push(() => { hooks[slot]?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); },
  };
  const filename = path.join(__dirname, '../src/features/language-practice/PracticeRecorder.tsx');
  Module._load = function(request, parent, isMain) {
    if (request === 'react') return fakeReact;
    if (parent.filename === filename && request === '../../components/ui/button') return { Button: 'Button' };
    if (parent.filename === filename && request === './recording-silence') return { monitorRecordingSilence(_stream, callback) {
      const monitor = { callback, stops: 0, stop() { this.stops++; }, ready: Promise.resolve(true) };
      monitors.push(monitor); return monitor;
    } };
    return savedLoad.call(this, request, parent, isMain);
  };
  class Recorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm';
    start() { this.state = 'recording'; this.dispatchEvent(new Event('start')); }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      finalEvents.push(() => {
        this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['voice'], { type: this.mimeType }) }));
        this.dispatchEvent(new Event('stop'));
      });
    }
  }
  const setGlobal = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  setGlobal('navigator', { mediaDevices: { async getUserMedia() { microphones++; return { getTracks: () => [{ stop() { trackStops++; } }] }; } } });
  setGlobal('window', new EventTarget()); setGlobal('MediaRecorder', Recorder);
  setGlobal('performance', { now: () => time }); setGlobal('setInterval', () => 1); setGlobal('clearInterval', () => {});
  delete require.cache[filename];
  const { PracticeRecorder } = require(filename);
  Module._load = savedLoad;
  const props = { onRecorded: blob => recordings.push(blob) };
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)];
  const render = () => { index = 0; const tree = PracticeRecorder(props); effects.splice(0).forEach(effect => effect()); return tree; };
  const button = () => nodes(render()).find(node => node.type === 'Button');
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  t.after(() => {
    hooks.forEach(hook => hook?.cleanup?.());
    Module._load = savedLoad;
    for (const [key, descriptor] of Object.entries(savedGlobals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  render();
  assert.equal(microphones, 0, 'no recording begins on mount');
  const initial = nodes(render());
  const startButton = initial.find(node => node.type === 'Button');
  assert.ok(nodes(startButton).some(node => node.type === 'svg'), 'record action has microphone icon');
  assert.ok(nodes(startButton).some(node => node.type === 'kbd' && node.props.children === 'Space'));
  const hint = initial.find(node => node.props.role === 'tooltip');
  assert.equal(startButton.props['aria-describedby'], hint.props.id);
  assert.match(hint.props.children, /When you are ready.*Press Space/);

  button().props.onClick(); await flush(); render();
  assert.equal(microphones, 1);
  time = 65000; assert.equal(monitors.length, 0, 'no silence monitor installed'); button().props.onClick(); render();
  assert.equal(recordings.length, 0, 'do not submit before the final audio chunk');
  assert.equal(trackStops, 0, 'do not release tracks before recorder finalization');
  assert.equal(button().props.disabled, true, 'cannot start a new capture while finalizing');
  let latestCallbackUsed = false;
  props.onRecorded = blob => { latestCallbackUsed = true; recordings.push(blob); };
  props.onBusyChange = () => {};
  render();
  finalEvents.splice(0).forEach(deliver => deliver());
  render();
  assert.equal(latestCallbackUsed, true, 'use the current parent callback after async finalization');
  assert.equal(trackStops, 1);
  assert.equal(recordings.length, 1);
  assert.ok(recordings[0] instanceof Blob);
  await flush();
  assert.equal(recordings.length, 1, 'late or duplicate silence cannot resend');
  assert.equal(microphones, 1, 'next turn does not start automatically');
  assert.equal(button().props['aria-label'], 'Start recording');
  button().props.onClick(); await flush(); render();
  assert.equal(microphones, 2, 'user can explicitly start another turn');
  assert.equal(monitors.length, 0, 'silence cannot stop any turn');
  time = 70000; button().props.onClick();
  finalEvents.splice(0).forEach(deliver => deliver());
  assert.equal(recordings.length, 2, 'manual stop still submits');
  render();
  button().props.onClick(); await flush(); render();
  time = 75000; button().props.onClick(); render();
  props.disabled = true; render();
  finalEvents.splice(0).forEach(deliver => deliver());
  assert.equal(recordings.length, 2, 'cancelling while finalizing must not send a late recording');

});
