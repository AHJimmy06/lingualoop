const test = require('node:test');
const assert = require('node:assert/strict');
const { constants } = require('node:fs');
const {
  loadTokenSigningKey,
  TOKEN_SIGNING_KEY_ENV,
  TOKEN_SIGNING_KEY_FILE_ENV,
} = require('../../dist/auth/token-signing-key.config.js');

const validPath = '/synthetic/lingualoop-key';
const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));

function fileSystem({ file = keyBytes, regular = true, mode = 0o100600, openFailure } = {}) {
  const calls = [];
  return {
    calls,
    open(path, flags) {
      calls.push(['open', path, flags]);
      assert.equal(path, validPath);
      if (openFailure) throw openFailure;
      return 42;
    },
    fstat(fd) {
      calls.push(['fstat', fd]);
      assert.equal(fd, 42);
      return { isFile: () => regular, mode };
    },
    readFile(fd) {
      calls.push(['readFile', fd]);
      assert.equal(fd, 42);
      return file;
    },
    close(fd) {
      calls.push(['close', fd]);
      assert.equal(fd, 42);
    },
  };
}

test('securely opens and loads raw bytes from a restrictive regular key file', () => {
  const fs = fileSystem();
  const key = loadTokenSigningKey({ [TOKEN_SIGNING_KEY_FILE_ENV]: validPath }, fs);
  assert.deepEqual(key, keyBytes);
  assert.equal(fs.calls[0][0], 'open');
  assert.ok(fs.calls[0][2] & constants.O_NOFOLLOW);
  assert.equal(fs.calls.at(-1)[0], 'close');
});

test('retains the environment-string key option', () => {
  assert.equal(loadTokenSigningKey({ [TOKEN_SIGNING_KEY_ENV]: 'x'.repeat(32) }), 'x'.repeat(32));
});

test('rejects missing, conflicting, empty, or short key sources', () => {
  assert.throws(() => loadTokenSigningKey({}), /source is required/);
  assert.throws(() => loadTokenSigningKey({
    [TOKEN_SIGNING_KEY_FILE_ENV]: validPath,
    [TOKEN_SIGNING_KEY_ENV]: 'x'.repeat(32),
  }, fileSystem()), /exactly one/);
  assert.throws(() => loadTokenSigningKey({ [TOKEN_SIGNING_KEY_ENV]: '' }), /invalid/);
  const shortFile = fileSystem({ file: Buffer.alloc(31) });
  assert.throws(() => loadTokenSigningKey({ [TOKEN_SIGNING_KEY_FILE_ENV]: validPath }, shortFile), /unavailable or invalid/);
  assert.equal(shortFile.calls.at(-1)[0], 'close');
});

test('rejects malformed paths, directories, and files without owner-read or with group/other access', () => {
  for (const path of ['', 'relative/key', ' /absolute/key']) {
    assert.throws(() => loadTokenSigningKey({ [TOKEN_SIGNING_KEY_FILE_ENV]: path }), /absolute path/);
  }
  for (const options of [
    { regular: false, mode: 0o40700 },
    { mode: 0o100200 },
    { mode: 0o100640 },
    { mode: 0o100604 },
  ]) {
    const fs = fileSystem(options);
    assert.throws(() => loadTokenSigningKey({ [TOKEN_SIGNING_KEY_FILE_ENV]: validPath }, fs), /unavailable or invalid/);
    assert.equal(fs.calls.at(-1)[0], 'close');
    assert.equal(fs.calls.some(([operation]) => operation === 'readFile'), false);
  }
});

test('no-follow open rejects symlinks and missing files with generic errors', () => {
  for (const failure of [new Error('ELOOP /private/secret'), new Error('ENOENT /private/secret')]) {
    const fs = fileSystem({ openFailure: failure });
    assert.throws(() => loadTokenSigningKey({ [TOKEN_SIGNING_KEY_FILE_ENV]: validPath }, fs), (error) => {
      assert.match(error.message, /unavailable or invalid/);
      assert.doesNotMatch(error.message, /private|secret|ELOOP|ENOENT/);
      return true;
    });
    assert.ok(fs.calls[0][2] & constants.O_NOFOLLOW);
    assert.equal(fs.calls.some(([operation]) => operation === 'close'), false);
  }
});

test('closes an opened descriptor after metadata or read failures without leaking details', () => {
  for (const failureAt of ['fstat', 'readFile']) {
    const calls = [];
    const fs = {
      open: () => 42,
      fstat() { calls.push('fstat'); if (failureAt === 'fstat') throw new Error('private metadata'); return { isFile: () => true, mode: 0o100600 }; },
      readFile() { calls.push('readFile'); throw new Error('private contents'); },
      close(fd) { assert.equal(fd, 42); calls.push('close'); },
    };
    assert.throws(() => loadTokenSigningKey({ [TOKEN_SIGNING_KEY_FILE_ENV]: validPath }, fs), (error) => {
      assert.match(error.message, /unavailable or invalid/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(calls.at(-1), 'close');
  }
});
