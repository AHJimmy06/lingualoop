const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  ABSOLUTE_SESSION_TTL_MS,
  absoluteSessionExpiry,
  createRefreshCredential,
  parseRefreshCredential,
} = require('../../dist/auth/refresh-credential.js');

const SESSION = '323e4567-e89b-42d3-a456-426614174000';
const SECRET = Buffer.alloc(32, 7).toString('base64url');
const SYNTHETIC_CREDENTIAL = `${SESSION}.${SECRET}`;
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

test('creates opaque credentials with canonical session UUID and a hash of the full credential', () => {
  const created = createRefreshCredential(SESSION.toUpperCase());
  assert.equal(created.credential.length, 80);
  assert.match(created.credential, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(created.credential.slice(0, 36), SESSION);
  assert.equal(Buffer.from(created.credential.slice(37), 'base64url').length, 32);
  assert.equal(created.hash, digest(created.credential));
  assert.match(created.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(createRefreshCredential(SESSION).hash, created.hash);
});

test('parses synthetic credentials into only the session UUID and full-token hash', () => {
  const parsed = parseRefreshCredential(SYNTHETIC_CREDENTIAL);
  assert.deepEqual(parsed, { sessionUuid: SESSION, hash: digest(SYNTHETIC_CREDENTIAL) });
  assert.equal(Object.hasOwn(parsed, 'secret'), false);
});

test('rejects malformed, noncanonical, legacy, Unicode, and control-containing tokens generically', () => {
  const malformed = [
    '', 'old-NousAI-token', `${SESSION.toUpperCase()}.${SECRET}`,
    `${SESSION}.${'A'.repeat(42)}B`, `${SESSION}.${SECRET.slice(0, 42)}!`,
    `${SESSION}.${SECRET}=`, `${SESSION}.${SECRET}x`, `${SESSION}\n.${SECRET}`,
    `${SESSION}.${SECRET}\u0000`, `${SESSION}.${SECRET}é`, `${SESSION}.${Buffer.alloc(31).toString('base64url')}`,
    `${SESSION.slice(0, -1)}z.${SECRET}`,
  ];
  for (const token of malformed) {
    assert.throws(() => parseRefreshCredential(token), (error) =>
      error.message === 'Invalid refresh credential.' && (token.length === 0 || !error.message.includes(token)));
  }
  assert.throws(() => createRefreshCredential('not-a-uuid'), { message: 'Invalid refresh credential.' });
});

test('uses a fixed seven-day absolute expiry and rejects invalid or overflowing timestamps', () => {
  const nowMs = 1_700_000_000_000;
  assert.equal(ABSOLUTE_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(absoluteSessionExpiry(nowMs), nowMs + ABSOLUTE_SESSION_TTL_MS);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => absoluteSessionExpiry(invalid), RangeError);
  }
});
