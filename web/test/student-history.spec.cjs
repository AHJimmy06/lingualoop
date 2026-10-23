const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript');
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,filename);
const {LanguagePracticeClient}=require('../src/features/language-practice/language-practice-client.ts');
const {resolveRoute}=require('../src/react-route-policy.ts');
const item={id:'550e8400-e29b-41d4-a716-446655440001',status:'COMPLETED',title:null,topic:'travel',level:'B1',difficulty:null,durationMinutes:5,startedAt:'2026-01-01T00:00:00.000Z',finishedAt:'2026-01-02T00:00:00.000Z',reportReady:true};
test('history uses authenticated read-only path and validates private bounded responses',async()=>{
 let body={sessions:[item],nextOffset:null};const calls=[];
 const client=new LanguagePracticeClient({async getWithRefresh(url){calls.push(url);return Response.json(body)}});
 assert.deepEqual(await client.getHistory(),body);assert.deepEqual(calls,['/api/language-practice/history?offset=0']);
 for(const invalid of [{sessions:[{...item,ownerId:'private'}],nextOffset:null},{sessions:[item,item],nextOffset:null},{sessions:[{...item,status:'ACTIVE'}],nextOffset:null},{sessions:[{...item,difficulty:'unknown'}],nextOffset:null},{sessions:[item],nextOffset:20}]){body=invalid;await assert.rejects(client.getHistory(),{kind:'invalid-response'})}
 const before=calls.length;for(const offset of [-1,1.5,100001])await assert.rejects(client.getHistory(offset),{kind:'invalid-input'});assert.equal(calls.length,before);
});
test('history route is student-only and links to full report, with pagination and safe empty/error states',()=>{
 assert.deepEqual(resolveRoute('/language-practice/history','','authenticated','student'),{kind:'render'});
 for(const role of ['admin','teacher'])assert.equal(resolveRoute('/language-practice/history','','authenticated',role).kind,'redirect');
 assert.equal(resolveRoute('/language-practice/history','','no-session').to,'/login');
 const view=fs.readFileSync(require.resolve('../src/features/language-practice/PracticeHistoryView.tsx'),'utf8');
 for(const text of ['No completed practices yet','Try again','Loading your practice history','Open full feedback','History pages'])assert.ok(view.includes(text));
 assert.ok(view.includes('/complete`'));assert.ok(view.includes('client.getHistory(offset)'));assert.ok(view.includes('active = false'));
 assert.ok(fs.readFileSync(require.resolve('../src/features/language-practice/LanguagePracticeSetupView.tsx'),'utf8').includes('My history'));
});
