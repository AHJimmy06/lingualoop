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

test('silence sends the current recording once; a later turn requires another explicit start', async t => {
  const savedLoad = Module._load;
  const savedGlobals = Object.fromEntries(['navigator', 'window', 'MediaRecorder', 'performance', 'setInterval', 'clearInterval'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let index = 0, time = 0, microphones = 0;
  const hooks = [], effects = [], monitors = [], recordings = [];
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
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['voice'], { type: this.mimeType }) }));
      this.dispatchEvent(new Event('stop'));
    }
  }
  const setGlobal = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  setGlobal('navigator', { mediaDevices: { async getUserMedia() { microphones++; return { getTracks: () => [{ stop() {} }] }; } } });
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
  button().props.onClick(); await flush(); render();
  assert.equal(microphones, 1);
  time = 2500; monitors[0].callback(); render();
  assert.equal(recordings.length, 1);
  assert.ok(recordings[0] instanceof Blob);
  monitors[0].callback(); await flush();
  assert.equal(recordings.length, 1, 'late or duplicate silence cannot resend');
  assert.equal(microphones, 1, 'next turn does not start automatically');
  assert.equal(button().props['aria-label'], 'Start recording');
  button().props.onClick(); await flush(); render();
  assert.equal(microphones, 2, 'user can explicitly start another turn');
  monitors[0].callback(); assert.equal(recordings.length, 1, 'old monitor cannot stop a new turn');
  time = 5000; button().props.onClick();
  assert.equal(recordings.length, 2, 'manual stop still submits');
});
