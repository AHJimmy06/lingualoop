const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: filename }).outputText, filename);
const id = '123e4567-e89b-42d3-a456-426614174000';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('cover lifecycle owns URLs, skips absent covers, falls back on fetch/decode failure and cancels late results', async () => {
  const originalLoad = Module._load;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const made = [], revoked = [], effects = [];
  let state = null, result, calls = 0;
  Module._load = function(request, parent, isMain) {
    if (request === 'react') return { ...React, useState: () => [state, value => { state = value; }], useEffect: effect => effects.push(effect), useMemo: factory => factory() };
    if (request === './language-practice-client' && parent.filename.endsWith('PracticeImage.tsx')) return { LanguagePracticeClient: class { getPracticeImage() { calls++; return result; } } };
    return originalLoad.call(this, request, parent, isMain);
  };
  URL.createObjectURL = () => { const url = `blob:cover-${made.length}`; made.push(url); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    const { PracticeImage } = require('../src/features/language-practice/PracticeImage.tsx');
    const props = { practice: { id, hasImage: true, setup: { topic: 'travel' } }, className: 'cover' };
    const mount = input => { effects.length = 0; const element = PracticeImage(input); const cleanup = effects.shift()(); return { element, cleanup }; };
    let render = mount({ ...props, practice: { ...props.practice, hasImage: false } });
    assert.equal(calls, 0); assert.match(render.element.props.src, /travel-scene.webp/); render.cleanup();
    result = Promise.resolve(new Blob(['jpeg'], { type: 'image/jpeg' }));
    render = mount(props); await tick();
    assert.equal(state.url, made[0]);
    render.cleanup(); assert.deepEqual(revoked, [made[0]]);
    state = { id, url: made[0] };
    render = mount(props); await tick();
    const loaded = PracticeImage(props);
    loaded.props.onError();
    assert.equal(state, null); assert.ok(revoked.includes(made[1])); render.cleanup();
    result = Promise.reject(Error('404'));
    render = mount(props); await tick(); assert.equal(state, null); render.cleanup();
    let resolve;
    result = new Promise(done => { resolve = done; });
    render = mount(props); render.cleanup();
    const count = made.length; resolve(new Blob(['late'])); await tick();
    assert.equal(made.length, count, 'cancelled late response must not allocate a URL');
    assert.equal(state, null);
  } finally { Module._load = originalLoad; URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});
