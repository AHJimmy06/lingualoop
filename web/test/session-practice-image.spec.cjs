const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript'), React = require('react');
const tick = () => new Promise(resolve => setImmediate(resolve));
function mount(request) {
 const file = path.resolve(__dirname, '../src/features/language-practice/SessionPracticeImage.tsx');
 const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
 let state = [], index = 0, effect; const original = m.require.bind(m);
 m.require = name => {
  if (name === 'react') return {...React, useMemo: f=>f(), useEffect: f=>{effect=f;}, useState: initial=>{const i=index++; if (!(i in state)) state[i]=initial; return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];}};
  if (name === './language-practice-client') return {LanguagePracticeClient:class{getSessionImage(id){return request(id);}}};
  if (name === '../../auth-session') return {authSession:{}};
  if (name === './PracticeScene') return {PracticeScene:'PracticeScene'};
  return original(name);
 };
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,file);
 return {render(id='a'){index=0;return m.exports.SessionPracticeImage({sessionId:id,topic:'travel'});},run(){return effect();}};
}
function nodes(n){return !n||typeof n!=='object'?[]:[n,...React.Children.toArray(n.props?.children).flatMap(nodes)];}
test('fresh load and reload resolve session image and show full material, not a generic scene',async()=>{
 const make=URL.createObjectURL,revoke=URL.revokeObjectURL,ids=[],revoked=[];
 URL.createObjectURL=()=> 'blob:teacher'; URL.revokeObjectURL=u=>revoked.push(u);
 try{
  for(let reload=0;reload<2;reload++){
   const h=mount(async id=>{ids.push(id);return new Blob(['jpeg']);});
   assert.ok(nodes(h.render()).some(n=>n.props?.role==='status'));
   const cleanup=h.run();await tick();const tree=nodes(h.render());
   const img=tree.find(n=>n.type==='img');assert.equal(img.props.src,'blob:teacher');assert.match(img.props.className,/object-contain/);
   assert.ok(tree.some(n=>n.type==='a'&&n.props.href==='blob:teacher'));assert.ok(!tree.some(n=>n.type==='PracticeScene'));
   assert.ok(!nodes(h.render('b')).some(n=>n.type==='img'),'old cover hidden synchronously on session change');
   img.props.onError();assert.ok(nodes(h.render()).some(n=>n.props?.role==='alert'));cleanup();
  }
  assert.deepEqual(ids,['a','a']);assert.equal(revoked.length,2);
 }finally{URL.createObjectURL=make;URL.revokeObjectURL=revoke;}
});
test('only explicit absence uses generic scene; failure shows retry and late results are ignored',async()=>{
 for(const absent of [true,false]){
  const h=mount(async()=>{if(absent)return null;throw Error();});h.render();const cleanup=h.run();await tick();const tree=nodes(h.render());
  assert.equal(tree.some(n=>n.type==='PracticeScene'),absent);
  if(!absent){assert.ok(tree.some(n=>n.props?.role==='alert'));tree.find(n=>n.type==='button').props.onClick();}
  cleanup();
 }
 let resolve;const h=mount(()=>new Promise(done=>{resolve=done;}));h.render();const cleanup=h.run();cleanup();resolve(new Blob(['late']));await tick();assert.ok(!nodes(h.render('b')).some(n=>n.type==='img'));
});
test('switching activities fetches the second session image instead of reusing the first',async()=>{
 const make=URL.createObjectURL,revoke=URL.revokeObjectURL;let counter=0;const ids=[];
 URL.createObjectURL=()=>`blob:activity-${++counter}`;URL.revokeObjectURL=()=>{};
 try{
  const h=mount(async id=>{ids.push(id);return new Blob([id]);});
  h.render('a');const firstCleanup=h.run();await tick();assert.equal(nodes(h.render('a')).find(n=>n.type==='img').props.src,'blob:activity-1');
  firstCleanup();assert.ok(!nodes(h.render('b')).some(n=>n.type==='img'));
  const secondCleanup=h.run();await tick();assert.equal(nodes(h.render('b')).find(n=>n.type==='img').props.src,'blob:activity-2');
  assert.deepEqual(ids,['a','b']);secondCleanup();
 }finally{URL.createObjectURL=make;URL.revokeObjectURL=revoke;}
});
