const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { readPreferences, savePreferences } = require('../src/features/language-practice/practice-preferences.ts');
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const fallback = { level: 'A1', durationMinutes: 5, difficulty: 'medium' };
function storage(value) { const entries = new Map([[`lingualoop:default-preferences:${owner}`, JSON.stringify(value)]]); return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) }; }
test('old valid preferences retain CEFR and time but use medium only for future defaults', () => {
  assert.deepEqual(readPreferences(owner, storage({ level: 'B2', durationMinutes: 15 })), { level: 'B2', durationMinutes: 15, difficulty: 'medium' });
});
test('three-field preferences round-trip per owner without coupling difficulty to CEFR', () => {
  const store = storage(null);
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const value = { level: 'C2', durationMinutes: 10, difficulty };
    assert.equal(savePreferences(owner, value, store), true);
    assert.deepEqual(readPreferences(owner, store), value);
    assert.deepEqual(readPreferences(other, store), fallback);
  }
});
test('invalid records and storage failures are safe and do not save invalid preferences', () => {
  for (const value of [null, [], { level: 'B2', durationMinutes: 15, difficulty: null }, { level: 'B2', durationMinutes: 15, difficulty: 1 }, { level: 'B2', durationMinutes: 15, difficulty: 'HARD' }, { level: 'B2', durationMinutes: 15, difficulty: 'hard', extra: true }, { level: 'Z9', durationMinutes: 5 }]) {
    assert.deepEqual(readPreferences(owner, storage(value)), fallback);
    assert.equal(savePreferences(owner, value, storage(null)), false);
  }
  assert.equal(savePreferences(owner, { level: 'B2', durationMinutes: 15 }, storage(null)), false);
  const broken = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.deepEqual(readPreferences(owner, broken), fallback);
  assert.equal(savePreferences(owner, fallback, broken), false);
  assert.deepEqual(readPreferences('invalid', broken), fallback);
  assert.equal(savePreferences('invalid', fallback, broken), false);
  assert.deepEqual(readPreferences(owner, { getItem: () => '{bad json' }), fallback);
});
