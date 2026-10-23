const test=require('node:test'),assert=require('node:assert/strict');
const {LanguagePracticeSessionStore}=require('../dist/language-practice/language-practice-session-store');
const owner='550e8400-e29b-41d4-a716-446655440000';
const row={id:'550e8400-e29b-41d4-a716-446655440001',status:'COMPLETED',title:null,topic:'travel',level:'B1',difficulty:null,durationMinutes:5,startedAt:new Date('2026-01-01'),finishedAt:new Date('2026-01-02'),reportReady:true};
test('history is owner-bound, read-only, ordered and paginated without generating reports',async()=>{
 const calls=[];const store=new LanguagePracticeSessionStore({async query(sql,args){calls.push({sql,args});return {rows:Array.from({length:21},(_,i)=>({...row,id:'550e8400-e29b-41d4-a716-'+String(i).padStart(12,'0')}))}}});
 const page=await store.listHistory(owner,20);
 assert.equal(page.sessions.length,20);assert.equal(page.nextOffset,40);assert.equal(page.sessions[0].difficulty,null);
 assert.deepEqual(calls[0].args,[owner,20]);assert.match(calls[0].sql,/WHERE s.owner_id = \$1/);assert.match(calls[0].sql,/ORDER BY s.started_at DESC, s.id DESC LIMIT 21 OFFSET \$2/);
 assert.doesNotMatch(calls[0].sql,/INSERT|UPDATE|DELETE/);
 for(const bad of [-1,1.5,100001,NaN])await assert.rejects(store.listHistory(owner,bad));
 assert.equal(calls.length,1);
});
test('history empty states and malformed database rows fail safely',async()=>{
 const empty=new LanguagePracticeSessionStore({async query(){return {rows:[]}}});
 assert.deepEqual(await empty.listHistory(owner),{sessions:[],nextOffset:null});
 for(const invalid of [{...row,status:'ACTIVE'},{...row,reportReady:'yes'},{...row,title:''},{...row,id:'bad'}]){
  const store=new LanguagePracticeSessionStore({async query(){return {rows:[invalid]}}});
  await assert.rejects(store.listHistory(owner));
 }
});
