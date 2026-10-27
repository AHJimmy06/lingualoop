const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),path=require('node:path');
const {Client}=require('pg');
const {runLinguaLoopMigrations}=require('../../dist/db/migrate');
const {LanguagePracticeSessionStore}=require('../../dist/language-practice/language-practice-session-store');
const {PracticeCatalogueStore}=require('../../dist/language-practice/practice-catalogue');
const {LanguagePracticeTurnStore}=require('../../dist/language-practice/language-practice-turn-store');
const {LanguagePracticeTurnService}=require('../../dist/language-practice/language-practice-turn.service');
const {randomUUID}=require('node:crypto');
const docker=args=>{const r=spawnSync('docker',args,{encoding:'utf8',timeout:60000});if(r.status!==0)throw Error(`Disposable Docker test failed: ${args[0]}`);return r.stdout.trim();};
test('real PostgreSQL: context snapshot, single-response concurrency, automatic closure, replay and full transcript',{timeout:180000},async()=>{
 let container,db;
 try{
  container=docker(['run','--rm','-d','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=disposable-activity-test','postgres:16-alpine']);
  const port=Number(docker(['port',container,'5432/tcp']).split(':').at(-1));
  const config={host:'127.0.0.1',port,user:'postgres',password:'disposable-activity-test',database:'postgres'};
  for(let i=0;i<60;i++){db=new Client(config);try{await db.connect();break;}catch{await db.end().catch(()=>{});db=null;await new Promise(r=>setTimeout(r,500));}}
  assert.ok(db);const query=db.query.bind(db); db.query=async(...args)=>{try{return await query(...args);}catch(error){console.error('Disposable migration SQL failure:',error.message);throw error;}};assert.equal(await runLinguaLoopMigrations(db,path.resolve(__dirname,'../../db/migrations')),17);
  db=new Client(config);await db.connect();assert.equal(await runLinguaLoopMigrations(db,path.resolve(__dirname,'../../db/migrations')),0);
  db=new Client(config);await db.connect();
  const owner=randomUUID(),teacher=randomUUID(),other=randomUUID();
  for(const [id,role] of [[owner,'student'],[teacher,'teacher'],[other,'student']])await db.query(`INSERT INTO lingualoop_accounts(id,issuer,subject,name,email,role) VALUES($1::uuid,'local',$1::text,'Test',$2,$3)`,[id,`${role}${id}@example.test`,role]);
  const executor={query:(sql,values)=>db.query(sql,values),async withTransaction(fn){
    await db.query('BEGIN');try{const value=await fn({query:this.query});await db.query('COMMIT');return value;}catch(e){await db.query('ROLLBACK');throw e;}
  }};
  const catalogue=new PracticeCatalogueStore(executor),sessions=new LanguagePracticeSessionStore(executor),turns=new LanguagePracticeTurnStore(executor);
  const compatible=await catalogue.create(teacher,{title:'Legacy caller without activity',setup:{level:'B2',durationMinutes:5},parameters:[{requirement:'Explain your opinion.'}]});
  assert.deepEqual(compatible.activity,{mode:'conversation',aiRole:'',location:''});
  const activity={mode:'single-response',aiRole:'A friend',location:'A wooded park'};
  const practice=await catalogue.create(teacher,{title:'Describe the scene',setup:{level:'B2',durationMinutes:5},parameters:[{requirement:'Explain what the friends might enjoy.'}],activity});
  const session=await sessions.createCustomSession(owner,practice.id);assert.deepEqual(session.activity,activity);assert.equal(session.remainingMs,86400000);
  await db.query(`UPDATE lingualoop_practices SET activity=$2::jsonb WHERE id=$1`,[practice.id,JSON.stringify({...activity,location:'Changed later'})]);
  assert.deepEqual((await sessions.getOwnedSnapshot(owner,session.id)).activity,activity);
  assert.equal(await sessions.getSession(other,session.id),null);
  // Empty exits remove only the learner's session, never the activity or evidence.
  const empty=await sessions.createCustomSession(owner,practice.id);
  assert.equal(await sessions.finishSession(other,empty.id),null);
  assert.deepEqual(await sessions.finishSession(owner,empty.id),{id:empty.id,status:'DISCARDED'});
  assert.equal(await sessions.getSession(owner,empty.id),null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lingualoop_language_practice_reports WHERE session_id=$1',[empty.id])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lingualoop_practices WHERE id=$1',[practice.id])).rows[0].n,1);
  const guarded=await sessions.createCustomSession(owner,practice.id);
  const guardedTurn=await turns.reserveTurn(owner,guarded.id,randomUUID());
  await assert.rejects(sessions.finishSession(owner,guarded.id),e=>e.reason==='turn_in_progress');
  assert.ok(await sessions.getSession(owner,guarded.id));
  await turns.failTurn(owner,guarded.id,guardedTurn.turn.id,guardedTurn.turn.leaseToken);
  assert.equal((await sessions.finishSession(owner,guarded.id)).status,'DISCARDED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lingualoop_language_practice_turns WHERE session_id=$1',[guarded.id])).rows[0].n,0);
  const first=randomUUID(),second=randomUUID();
  const admitted=await turns.reserveTurn(owner,session.id,first);
  await assert.rejects(turns.reserveTurn(owner,session.id,second),e=>e.reason==='turn_in_progress');
  const transcript='The friends might enjoy the fresh air and talking together. '.repeat(110);
  assert.ok(transcript.length>4000);
  assert.equal(await turns.completeTurn(owner,session.id,admitted.turn.id,admitted.turn.leaseToken,transcript,'Response submitted for assessment.',''),true);
  assert.equal((await sessions.getSession(owner,session.id)).status,'COMPLETED');
  assert.equal((await sessions.finishSession(owner,session.id)).status,'COMPLETED');
  assert.equal((await turns.listCompletedTurns(owner,session.id))[0].transcript,transcript);
  await assert.rejects(turns.reserveTurn(owner,session.id,second),e=>e.reason==='session_expired');
  assert.equal((await turns.reserveTurn(owner,session.id,first)).replay,true);
  // A failed processing attempt remains retryable; single mode never invokes conversation AI/TTS.
  const retrySession=await sessions.createCustomSession(owner,practice.id),turnId=randomUUID();
  const failed=await turns.reserveTurn(owner,retrySession.id,turnId);await turns.failTurn(owner,retrySession.id,failed.turn.id,failed.turn.leaseToken);
  const service=new LanguagePracticeTurnService({turnStore:turns,sessions:{getOwnedSession:(o,s)=>sessions.getOwnedSnapshot(o,s)},history:{getCompletedHistory:(o,s)=>turns.getCompletedHistory(o,s)},speechToText:{async transcribeBounded(){return transcript;}},coach:{async respond(){assert.fail('single response must not call conversation coach');}},synthesis:{async synthesizeLocal(){assert.fail('single response must not synthesize a coach reply');}}});
  const result=await service.processTurn(owner,retrySession.id,randomUUID(),{buffer:Buffer.from('audio'),mimeType:'audio/webm'});assert.equal(result.audioWav,null);assert.equal((await sessions.getSession(owner,retrySession.id)).status,'COMPLETED');
  assert.equal(result.turn.transcript,transcript);
  const {LanguagePracticeReportStore}=require('../../dist/language-practice/language-practice-report-store');
  const {LanguagePracticeReportService}=require('../../dist/language-practice/language-practice-report.service');
  const tx={query:executor.query,async withTransaction(fn){await db.query('BEGIN');try{const value=await fn(executor);await db.query('COMMIT');return value;}catch(e){await db.query('ROLLBACK');throw e;}}};
  const reportStore=new LanguagePracticeReportStore(tx);
  const legacy={summary:'Informe anterior.',corrections:[],strengths:[],recommendations:[]};
  await db.query(`INSERT INTO lingualoop_language_practice_reports(session_id,content,generated_with_ai) VALUES($1,$2::jsonb,true)`,[retrySession.id,JSON.stringify(legacy)]);
  let generations=0;
  const reports=new LanguagePracticeReportService(reportStore,{async generate(evidence,context){generations++;assert.equal(context.activity.mode,'single-response');assert.equal(evidence.length,1);assert.equal(evidence[0].transcript,transcript);return {summary:'The response explains why friends might enjoy the walk.',corrections:[],strengths:['You gave a relevant reason.'],recommendations:['Develop your reason with an example.'],parameterCoverage:practice.parameters.map(p=>({parameterId:p.id,requirement:p.requirement,status:'met',evidenceSequences:[2],explanation:'The response explains the benefits of walking together.'}))};}});
  const report=await reports.getOrCreate(owner,retrySession.id);assert.match(report.summary,/The response/);
  assert.equal((await reports.getOrCreate(owner,retrySession.id)).summary,report.summary);assert.equal(generations,1);
  const saved=await db.query('SELECT report_language,legacy_content FROM lingualoop_language_practice_reports WHERE session_id=$1',[retrySession.id]);
  assert.equal(saved.rows[0].report_language,'en');assert.deepEqual(saved.rows[0].legacy_content.content,legacy);

 }finally{if(db)await db.end();if(container)docker(['stop',container]);}
});
