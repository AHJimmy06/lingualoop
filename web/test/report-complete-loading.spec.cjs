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

test('report route stays loading until complete and retries failures without exposing partial content', async t => {
  const savedLoad = Module._load;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  let index = 0;
  const hooks = [], effects = [], requests = [];
  const changed = (old, deps) => !old || deps.some((value, i) => value !== old.deps[i]);
  const fakeReact = {
    ...React,
    useState(initial) { const slot = index++; if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial; return [hooks[slot], value => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; }]; },
    useMemo(fn, deps) { const slot = index++; if (changed(hooks[slot], deps)) hooks[slot] = { deps, value: fn() }; return hooks[slot].value; },
    useEffect(effect, deps) { const slot = index++; if (changed(hooks[slot], deps)) effects.push(() => { hooks[slot]?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); },
  };
  const filename = path.join(__dirname, '../src/features/language-practice/PracticeReportView.tsx');
  class ClientError extends Error { constructor(kind) { super(); this.kind = kind; } }
  class Client { getCompleteReport() { return new Promise((resolve, reject) => requests.push({ resolve, reject })); } }
  Module._load = function(request, parent, isMain) {
    if (request === 'react') return fakeReact;
    if (parent?.filename === filename) {
      if (request === 'react-router-dom') return { Link: 'Link', useParams: () => ({ sessionId: 'session-id' }) };
      if (request === '../../auth-session') return { authSession: {} };
      if (request === './PracticeReportContent') return { PracticeReportContent: 'CompleteReport' };
      if (request === './language-practice-client') return { LanguagePracticeClient: Client, LanguagePracticeClientError: ClientError };
    }
    return savedLoad.call(this, request, parent, isMain);
  };
  delete require.cache[filename];
  const { PracticeReportView } = require(filename);
  Module._load = savedLoad;
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)];
  const render = () => { index = 0; const tree = PracticeReportView(); effects.splice(0).forEach(effect => effect()); return tree; };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  t.after(() => { hooks.forEach(hook => hook?.cleanup?.()); Module._load = savedLoad; if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else delete globalThis.window; });
  let tree = render();
  assert.equal(requests.length, 1);
  assert.equal(nodes(tree).some(n => n.type === 'CompleteReport'), false);
  assert.equal(nodes(tree).some(n => n.props?.role === 'status'), true);
  requests[0].reject(new ClientError('unavailable')); await flush(); tree = render();
  assert.equal(nodes(tree).some(n => n.type === 'CompleteReport'), false, 'partial report must not be shown after support failure');
  const retry = nodes(tree).find(n => n.type === 'button' && n.props.children === 'Try again');
  assert.ok(retry);
  retry.props.onClick(); render(); tree = render();
  assert.equal(requests.length, 2);
  assert.equal(nodes(tree).some(n => n.type === 'CompleteReport'), false);
  const result = { report: { summary: 'Complete saved report' }, session: { turns: [] }, learningSupport: { corrections: [], strengths: [], recommendations: [] } };
  requests[1].resolve(result); await flush(); tree = render();
  const content = nodes(tree).find(n => n.type === 'CompleteReport');
  assert.ok(content); assert.equal(content.props.learningSupport, result.learningSupport);
  assert.equal(nodes(tree).some(n => n.props?.role === 'status'), false);
});
