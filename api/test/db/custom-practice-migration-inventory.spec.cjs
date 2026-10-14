const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadMigrations } = require('../../dist/db/migrate.js');
const oldChecksums = [
  '63522ee3fa20a6feb09aef53aedd2047c58cb986349e05a27dd25e6b07a73311',
  '54638261e35b399ea70b04fa7e6cd82dd3dee228c21aa4bbb7b3194c9b5c3c55',
  'bb9fdee81b3545dbfe45b435cd554b7df72367975101d7321c55eccdda5ef8d9',
  '3028e4e92c1eb5fc7632dae367428b6ca476963983ee67f1c4e16b7a463bea7a',
  'fe3f8ec5e98c2346d0ec13a09585a4375056adb160ce13d198c3d8c603bb9272',
  'ee61d49f26d563f460389b989474295ed9b39a806dbb8d341b4fffb27095222c',
  'ebc0195348da709978fecd67a93804ddd4f31476f4cadd6d996c8fc4dbbc417e',
  '2b9ea3e6036b75c99ea00a927edbb5c86fd2bfad5272873324d459eac704b3ca',
  '3127d8e5a47f84fe1b3046deae8af5e169713cbeecf55a4d61a32857af6aea07',
  '60edf295a5c83c900bde1a70b9d47c7a554c96e0b0cfdb84a335cd8a95b511d7',
  '066e059b5e4c4658c9409f1e9efc6147e3f67a70526a5cb577521c0eb2dd9f04',
  'b4ce99b3ceea90289aa90c4a630bb1ae2dcdfcda04e14435f4458b6c12ca0068',
];
test('existing runner accepts exact 013 inventory without running SQL; 001–012 checksums unchanged', async () => {
  const migrations = await loadMigrations(path.join(__dirname, '../../db/migrations'));
  assert.equal(migrations.length, 13);
  assert.deepEqual(migrations.slice(0, 12).map(item => item.checksum), oldChecksums);
  assert.equal(migrations[11].name, '012_custom_practice_theme_image.sql');
  assert.equal(migrations[12].name, '013_practice_difficulty.sql');
});
