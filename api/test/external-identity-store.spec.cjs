const test = require('node:test');
const assert = require('node:assert/strict');
const { IdentityStore, IdentityStoreError } = require('../dist/auth/identity-store.js');
const A='550e8400-e29b-41d4-a716-446655440000';
const B='650e8400-e29b-41d4-a716-446655440000';
function fixture(){
  let accounts=[]; let identities=[];
  const executor={
    async withTransaction(callback){const oldA=structuredClone(accounts),oldI=structuredClone(identities);try{return await callback(this)}catch(e){accounts=oldA;identities=oldI;throw e}},
    async query(sql,v){
      if(sql.startsWith('UPDATE lingualoop_accounts')){const a=accounts.find(a=>a.id===v[0]);if(a)a.name=v[1];return {rows:[]}};
      if(sql.includes('pg_advisory'))return {rows:[]};
      if(sql.includes('SELECT account_id')&&sql.includes('WHERE issuer'))return {rows:identities.filter(i=>i.issuer===v[0]&&i.subject===v[1]).map(i=>({account_id:i.account_id}))};
      if(sql.includes('SELECT account_id')&&sql.includes('WHERE account_id'))return {rows:identities.filter(i=>i.account_id===v[0])};
      if(sql.includes('FROM lingualoop_accounts WHERE email'))return {rows:accounts.filter(a=>a.email===v[0])};
      if(sql.includes('INSERT INTO lingualoop_accounts')){const a={id:accounts.length?B:A,name:v[0],email:v[1],role:v[2]};accounts.push(a);return {rows:[a]}};
      if(sql.includes('INSERT INTO lingualoop_external_identities')){identities.push({account_id:v[0],issuer:v[1],subject:v[2],email:v[3]});return {rows:[{account_id:v[0]}]}};
      throw Error('Unexpected query');
    }
  };
  return {store:new IdentityStore(executor),get accounts(){return accounts},get identities(){return identities}};
}
test('Google and Microsoft register in shared subject field and returning users are not duplicated',async()=>{
 const f=fixture();
 for(const [issuer,email,id] of [['google','g@example.test',A],['microsoft','m@example.test',B]]){
   const identity={issuer,subject:'same-provider-id',email,name:'Verified Name'};
   assert.equal(await f.store.linkExternalIdentity(identity),id);
   assert.equal(await f.store.linkExternalIdentity(identity),id);
 }
 assert.equal(f.accounts.length,2);assert.equal(f.identities.length,2);
 assert.ok(f.accounts.every(a=>a.role==='student'&&a.name==='Verified Name'&&!('password_hash'in a)));
 assert.equal(f.identities[0].subject,f.identities[1].subject);
});
test('only reserved verified Google identity becomes admin, not first arbitrary user',async()=>{
 const f=fixture();
 await f.store.linkExternalIdentity({issuer:'microsoft',subject:'first',email:'first@example.test'});
 assert.equal(f.accounts[0].role,'student');
 await f.store.linkExternalIdentity({issuer:'google',subject:'jimmy',email:'jimmy.anilema234@gmail.com',name:'Jimmy'});
 assert.equal(f.accounts[1].role,'admin');
});
test('rejects reserved Microsoft address and unsupported or malformed identities without persisting',async()=>{
 const f=fixture();
 for(const i of [
 {issuer:'microsoft',subject:'m',email:'jimmy.anilema234@gmail.com'},
 {issuer:'other',subject:'x',email:'a@example.test'},
 {issuer:'google',subject:' bad ',email:'a@example.test'},
 {issuer:'google',subject:'g',email:'a@example.test',name:'\0'}]){
   await assert.rejects(f.store.linkExternalIdentity(i),IdentityStoreError);
 }
 assert.equal(f.accounts.length,0);assert.equal(f.identities.length,0);
});
test('never merges another provider or changed subject into an already linked email',async()=>{
 const f=fixture();
 await f.store.linkExternalIdentity({issuer:'google',subject:'original',email:'a@example.test'});
 for(const issuer of ['google','microsoft'])await assert.rejects(f.store.linkExternalIdentity({issuer,subject:'different',email:'a@example.test'}),IdentityStoreError);
 assert.equal(f.accounts.length,1);assert.equal(f.identities.length,1);
});

test('invited teacher gets verified provider name without losing role and can refresh name later',async()=>{
 const f=fixture();f.accounts.push({id:A,email:'teacher@example.test',name:null,role:'teacher'});
 const identity={issuer:'microsoft',subject:'teacher-ms',email:'teacher@example.test',name:'Provider Teacher'};
 assert.equal(await f.store.linkExternalIdentity(identity),A);
 assert.equal(f.accounts[0].role,'teacher');assert.equal(f.accounts[0].name,'Provider Teacher');
 await f.store.linkExternalIdentity({...identity,name:'Updated Provider Name'});
 assert.equal(f.accounts[0].name,'Updated Provider Name');assert.equal(f.accounts[0].role,'teacher');
});
