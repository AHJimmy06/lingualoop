const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename);
const { ExclusiveReportAudio } = require('../src/features/language-practice/report-audio-playback.ts');

test('last volume press cancels previous ownership and late cleanup cannot stop the new audio', () => {
  const player = new ExclusiveReportAudio();
  const cancelled = [];
  let releaseFirst;
  releaseFirst = player.claim(() => { cancelled.push('English'); releaseFirst(); });
  const releaseSecond = player.claim(() => cancelled.push('Spanish'));
  assert.deepEqual(cancelled, ['English']);
  releaseFirst();
  const releaseThird = player.claim(() => cancelled.push('Explanation'));
  assert.deepEqual(cancelled, ['English', 'Spanish']);
  releaseSecond();
  releaseThird();
  player.claim(() => {});
  assert.deepEqual(cancelled, ['English', 'Spanish'], 'completed playback is not cancelled again');
});
