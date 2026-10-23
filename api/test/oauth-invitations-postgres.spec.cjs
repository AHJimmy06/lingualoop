const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
test('email-only reservations keep roles, take provider names, and uninvited users remain students',
{skip:process.env.LINGUALOOP_TEST_OAUTH_LOCAL!=='true'},async()=>{
 const {createLinguaLoopQueryExecutor,loadLinguaLoopPostgresConfig}=require('../dist/db/postgres.js');
 const {IdentityStore}=require('../dist/auth/identity-store.js');
 const {AccountStore}=require('../dist/auth/account-store.js');
 const config=loadLinguaLoopPostgresConfig();assert.equal(config.host,'127.0.0.1');
 const db=createLinguaLoopQueryExecutor(config);
 let completed=false;
 try{
 const before=(await db.query('SELECT count(*)::int AS n FROM lingualoop_accounts',[])).rows[0].n;
 await assert.rejects(db.withTransaction(async tx=>{
   const executor={query:(sql,v)=>tx.query(sql,v),withTransaction:callback=>callback(executor)};
   const store=new IdentityStore(executor),accounts=new AccountStore(executor);
   for(const issuer of ['google','microsoft']){
     const email=randomUUID()+'@invitation.example.test';
     const invited=await accounts.create({email,role:'teacher'});
     assert.equal(invited.name,null);
     const identity={issuer,subject:randomUUID(),email,name:'Provider Name'};
     assert.equal(await store.linkExternalIdentity(identity),invited.id);
     let actual=await store.findAccountByOwner(invited.id);
     assert.equal(actual.name,'Provider Name');assert.equal(actual.role,'teacher');
     await store.linkExternalIdentity({...identity,name:'Updated Name'});
     actual=await store.findAccountByOwner(invited.id);
     assert.equal(actual.name,'Updated Name');assert.equal(actual.role,'teacher');
     const id=await store.linkExternalIdentity({issuer,subject:randomUUID(),email:randomUUID()+'@new.example.test',name:'New Student'});
     assert.equal((await store.findAccountByOwner(id)).role,'student');
   }
   completed=true;throw Error('intentional test rollback');
 }));
 assert.equal(completed,true);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM lingualoop_accounts',[])).rows[0].n,before);
 }finally{await db.close()}
});
