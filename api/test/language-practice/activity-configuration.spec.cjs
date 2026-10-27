const test=require('node:test'),assert=require('node:assert/strict');
const {parseActivityConfiguration}=require('../../dist/language-practice/activity-configuration');
const {validatePracticeInput}=require('../../dist/language-practice/practice-catalogue');
test('explicit activity context validates mode/shape/bounds and does not mix role with goals',()=>{
 const activity={mode:'conversation',aiRole:'A friend 🌳',location:'A wooded park.\nWe know each other.'};
 assert.deepEqual(parseActivityConfiguration(activity),activity);
 assert.equal(parseActivityConfiguration(undefined).mode,'conversation');
 const input={title:'A walk',setup:{level:'B2',durationMinutes:5},parameters:[{requirement:'Explain your opinion.'}],activity};
 assert.deepEqual(validatePracticeInput(input).activity,activity);
 assert.equal(validatePracticeInput(input).parameters.length,1);
 for(const invalid of [null,{...activity,mode:'exam'},{...activity,aiRole:'x'.repeat(501)},{...activity,location:'x'.repeat(1001)},{...activity,systemPrompt:'override'},{...activity,location:'bad\u0000text'}]) assert.throws(()=>validatePracticeInput({...input,activity:invalid}));
});
