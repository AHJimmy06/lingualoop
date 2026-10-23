const test=require('node:test');
const assert=require('node:assert/strict');
test('local PostgreSQL OAuth registration, returning login, roles, shared IDs and session rotation roll back cleanly',
{skip:process.env.LINGUALOOP_TEST_OAUTH_LOCAL!=='true'},async()=>{
 const {createLinguaLoopQueryExecutor,loadLinguaLoopPostgresConfig}=require('../dist/db/postgres.js');
 const {IdentityStore}=require('../dist/auth/identity-store.js');
 const {GoogleLoginSession}=require('../dist/auth/google-login-session.js');
 const {SessionStore}=require('../dist/auth/session-store.js');
 const {RefreshStore}=require('../dist/auth/refresh-store.js');
 const {RefreshSession}=require('../dist/auth/refresh-session.js');
 const {LinguaLoopTokenService}=require('../dist/auth/lingualoop-token.service.js');
 const {JwtService}=require('@nestjs/jwt');
 const config=loadLinguaLoopPostgresConfig();
 assert.equal(config.host,'127.0.0.1');
 const db=createLinguaLoopQueryExecutor(config);
 const rollback=new Error('test rollback');
 let completed=false;
 try{
 const before=(await db.query('SELECT count(*)::int AS n FROM lingualoop_accounts',[])).rows[0].n;
 assert.equal(before,0,'Run only against explicitly reset empty local account table');
 await assert.rejects(db.withTransaction(async tx=>{
   const executor={query:(sql,v)=>tx.query(sql,v),withTransaction:callback=>callback(executor)};
   const store=new IdentityStore(executor);
   const tokens=new LinguaLoopTokenService(new JwtService({}),'test-only-registration-key-32-characters');
   const sessions=new SessionStore(executor),refresh=new RefreshStore(executor);
   const identities={
     admin:{issuer:'google',subject:'same-id',email:'jimmy.anilema234@gmail.com',name:'Jimmy'},
     student:{issuer:'microsoft',subject:'same-id',email:'oauth-test@example.test',name:'Test Student'}
   };
   const login=new GoogleLoginSession({googleIdentityService:{async verify(token){return identities[token]}},identityStore:store,sessionStore:sessions,refreshStore:refresh,tokenService:tokens});
   const first=await login.issue('admin');await login.issue('admin');await login.issue('student');
   const rows=(await tx.query('SELECT name,email,role FROM lingualoop_accounts ORDER BY role',[])).rows;
   assert.deepEqual(rows.map(r=>r.role),['admin','student']);assert.equal(rows[0].name,'Jimmy');
   assert.equal((await tx.query('SELECT count(*)::int AS n FROM lingualoop_external_identities WHERE subject=$1',['same-id'])).rows[0].n,2);
   const rotated=await new RefreshSession({refreshStore:refresh,sessionStore:sessions,tokenService:tokens}).refresh(first.refreshCredential);
   assert.ok(rotated.accessToken);assert.notEqual(rotated.refreshCredential,first.refreshCredential);
   const fields=(await tx.query("SELECT column_name FROM information_schema.columns WHERE table_name='lingualoop_accounts'",[])).rows;
   assert.equal(fields.some(f=>f.column_name==='password_hash'),false);
   completed=true;
   throw rollback;
 }));
 assert.equal(completed,true, "All in-transaction assertions must complete before intentional rollback");
 assert.equal((await db.query('SELECT count(*)::int AS n FROM lingualoop_accounts',[])).rows[0].n,before);
 }finally{await db.close()}
});
