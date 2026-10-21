const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadMigrations } = require('../../dist/db/migrate.js');
const oldChecksums = [
  '8aacb19fc30f116615c9483563cefac414f12d77c2eeea0d040dc2fb04fedc27',
  '45d4b1f7f8b6d980a37f37dfa8f1444d03fa59e2a2dd7193659efb333433dcf4',
  '59055a4f1ce2025d980277daf667512cce44850643e54e5ce55b5e6c0a12de99',
  'a42c6792d73da6d391c6216f646d912e47a681c3a8526af05ad1eb2ae72128a7',
  'e663e0bca5240ec3d5ba4f77a9c57a46b1d2c00d99891a51e3741be824ffd6c1',
  '9a589dfee053c1a32b104eecaa887f018638fc4fe5bdaee0457e6a1911f834cb',
  'ec8981bdb24caac3810e62705ba7e846ca42fced533f328ae334b9f2d8add09d',
  'd7e9380ff9b0d24d2561f172653148b853ee385e2a7df42966408e2ff92f37bf',
  'c1b835c3c363160844a3cc35ed11119f4b7b84d8d65d78ae31d2086aa0b27ccf',
  'b1939833da2901a648ea6d049a03d4e481da3a3974cbf27a4f6c73a85237ea16',
  'b99bfcfcdad797fa035285d7489941d5e566e6dfadcee2603d27b15676cd5908',
  '68e1d037ef76bd36ca9807a6a0f12eab4c7b322e261144ff80753ee4c270815e',
];
test('runner accepts additive 014 identity inventory; 001–012 checksums unchanged', async () => {
  const migrations = await loadMigrations(path.join(__dirname, '../../db/migrations'));
  assert.equal(migrations.length, 14);
  assert.deepEqual(migrations.slice(0, 12).map(item => item.checksum), oldChecksums);
  assert.equal(migrations[11].name, '012_custom_practice_theme_image.sql');
  assert.equal(migrations[12].name, '013_practice_difficulty.sql');
  assert.equal(migrations[13].name, '014_external_identity_providers.sql');
});
