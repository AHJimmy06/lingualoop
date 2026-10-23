const test=require('node:test'),assert=require('node:assert/strict');require('reflect-metadata');
const {Module,UnauthorizedException}=require('@nestjs/common');const {NestFactory}=require('@nestjs/core');
const {LanguagePracticeSessionController}=require('../dist/language-practice/language-practice-session.controller');
const {ConfiguredVerifiedRequestGuard}=require('../dist/auth/google-auth.providers');const {RoleGuard}=require('../dist/auth/role.guard');
const tokens=require('../dist/language-practice/language-practice-session.providers');
test('history HTTP requires student auth, ignores client owner authority and validates pagination before storage',async t=>{
 let role='student';const calls=[];const owner='550e8400-e29b-41d4-a716-446655440000';
 class Offline{}
 Module({controllers:[LanguagePracticeSessionController],providers:[RoleGuard,
 ConfiguredVerifiedRequestGuard,
 {provide:require('../dist/auth/lingualoop-token.service').LinguaLoopTokenService,useValue:{async verifyBearerToken(token){if(token!=='valid')throw new (require('../dist/auth/verified-request.guard').InvalidBearerTokenError)();return {issuer:'local',subject:owner,sessionId:owner}}}},
 {provide:require('../dist/auth/auth-store.providers').LINGUALOOP_IDENTITY_STORE,useValue:{async findOwnerByIdentity(){return owner},async findAccountByOwner(){return {name:'Student',email:'student@example.test',role}}}},
 {provide:require('../dist/auth/auth-store.providers').LINGUALOOP_SESSION_STORE,useValue:{async isSessionActive(){return true}}},
 {provide:tokens.LANGUAGE_PRACTICE_SESSION_STORE,useValue:{async listHistory(id,offset){calls.push([id,offset]);return {sessions:[],nextOffset:null}}}},
 {provide:tokens.LANGUAGE_PRACTICE_TURN_STORE,useValue:{}},
 {provide:tokens.LANGUAGE_PRACTICE_REPORT_SERVICE,useValue:{async getOrCreate(){throw Error('history must never generate reports')}}}
 ]})(Offline);
 const app=await NestFactory.create(Offline,{logger:false,abortOnError:false});t.after(()=>app.close());await app.listen(0,'127.0.0.1');const base=await app.getUrl();
 const request=(query='',auth=true)=>fetch(base+'/language-practice/history'+query,{headers:auth?{authorization:'Bearer valid'}:{}});
 assert.equal((await request('',false)).status,401);
 for(const r of ['teacher','admin']){role=r;assert.equal((await request()).status,403)}assert.deepEqual(calls,[]);
 role='student';const response=await request('?offset=20');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(await response.json(),{sessions:[],nextOffset:null});assert.deepEqual(calls,[[owner,20]]);
 for(const query of ['offset=-1','offset=1.5','offset=100001','offset=bad','ownerId=another-user','offset=0&offset=20'])assert.equal((await request('?'+query)).status,400);
 assert.equal(calls.length,1);
});
