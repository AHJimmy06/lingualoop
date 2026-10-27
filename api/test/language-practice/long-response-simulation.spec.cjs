const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {PracticeRuntimeHost}=require('../../dist/language-practice/practice-runtime.providers');
test('real STT HTTP client retains a long transcript through local Postman simulation',{skip:!process.env.LINGUALOOP_TEST_STT_SIM_URL},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lingualoop-sim-'));
 const host=new PracticeRuntimeHost({serverUrl:process.env.LINGUALOOP_TEST_STT_SIM_URL,startMode:'external',model:'base.en',port:4919,cpuThreads:2,serverScript:'unused',ffmpegExecutable:'unused'});
 try{await host.start();const file=path.join(root,'test.wav');await fs.writeFile(file,Buffer.alloc(44));const text=await host.getHost().transcribe(file);assert.ok(text.length>4000);assert.ok(text.endsWith('stories.'));}
 finally{await host.onApplicationShutdown();await fs.rm(root,{recursive:true,force:true});}
});
