const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
test('local PostgreSQL history isolates owners and excludes active practices without writing or generating reports',
{skip:process.env.LINGUALOOP_TEST_HISTORY_LOCAL!=='true'},async()=>{
 const {createLinguaLoopQueryExecutor,loadLinguaLoopPostgresConfig}=require('../dist/db/postgres');
 const {AccountStore}=require('../dist/auth/account-store');
 const {LanguagePracticeSessionStore}=require('../dist/language-practice/language-practice-session-store');
 const config=loadLinguaLoopPostgresConfig();assert.equal(config.host,'127.0.0.1');const db=createLinguaLoopQueryExecutor(config);let completed=false;
 try{
 const before=(await db.query('SELECT count(*)::int AS n FROM lingualoop_accounts',[])).rows[0].n;
 await assert.rejects(db.withTransaction(async tx=>{
  const accounts=new AccountStore(tx),sessions=new LanguagePracticeSessionStore(tx);
  const a=await accounts.create({email:randomUUID()+'@history.example.test',role:'student'}),b=await accounts.create({email:randomUUID()+'@history.example.test',role:'student'});
  const setup={topic:'travel',level:'B1',durationMinutes:5,difficulty:'easy'};
  const active=await sessions.createSession(a.id,setup),finished=await sessions.createSession(a.id,setup),expired=await sessions.createSession(a.id,setup),other=await sessions.createSession(b.id,setup);
  await sessions.finishSession(a.id,finished.id);await sessions.finishSession(b.id,other.id);
  await tx.query("UPDATE lingualoop_language_practice_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[expired.id]);
  const history=await sessions.listHistory(a.id);
  assert.equal(history.sessions.length,2);assert.ok(history.sessions.some(s=>s.id===finished.id&&s.status==='COMPLETED'));assert.ok(history.sessions.some(s=>s.id===expired.id&&s.status==='EXPIRED'));
  assert.ok(history.sessions.every(s=>s.id!==other.id&&s.id!==active.id&&!s.reportReady));
  assert.deepEqual((await sessions.listHistory(b.id)).sessions.map(s=>s.id),[other.id]);
  assert.deepEqual(await sessions.listHistory(a.id,20),{sessions:[],nextOffset:null});
  assert.equal((await tx.query('SELECT count(*)::int AS n FROM lingualoop_language_practice_reports WHERE session_id=ANY($1::uuid[])',[[finished.id,expired.id]])).rows[0].n,0);
  completed=true;throw Error('intentional rollback');
 }));assert.equal(completed,true);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM lingualoop_accounts',[])).rows[0].n,before);
 }finally{await db.close()}
});
