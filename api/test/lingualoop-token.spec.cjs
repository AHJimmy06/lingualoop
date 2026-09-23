const test = require('node:test');
const assert = require('node:assert/strict');
const { JwtService } = require('@nestjs/jwt');
const { InvalidBearerTokenError } = require('../dist/auth/verified-request.guard.js');
const {
  LinguaLoopTokenService,
} = require('../dist/auth/lingualoop-token.service.js');

const KEY = Buffer.from('lingualoop test signing key with 32+ bytes');
const OTHER_KEY = Buffer.from('different test signing key with 32+ bytes');
const jwt = new JwtService();

function service(key = KEY) {
  return new LinguaLoopTokenService(jwt, key);
}

async function signRaw(payload, options = {}) {
  return jwt.signAsync(payload, {
    algorithm: 'HS256',
    secret: KEY,
    ...options,
  });
}

async function rejectsAsInvalid(promise) {
  await assert.rejects(promise, InvalidBearerTokenError);
}

test('issues and verifies a provider-neutral identity token', async () => {
  const token = await service().issue({ issuer: 'google', subject: 'provider-user-123' });

  assert.equal(typeof token, 'string');
  const claims = jwt.decode(token);
  assert.equal(claims.iss, 'lingualoop');
  assert.equal(claims.aud, 'lingualoop-api');
  assert.equal(claims.exp - claims.iat, 900);
  assert.deepEqual(await service().verifyBearerToken(token), {
    issuer: 'google',
    subject: 'provider-user-123',
  });
});

test('accepts a stable provider identifier and opaque non-ASCII subject', async () => {
  const token = await service().issue({ issuer: 'tenant.provider-2', subject: '用户-123' });

  assert.deepEqual(await service().verifyBearerToken(token), {
    issuer: 'tenant.provider-2',
    subject: '用户-123',
  });
});

test('rejects tampered tokens, malformed tokens, and oversized tokens', async () => {
  const token = await service().issue({ issuer: 'microsoft', subject: 'user-1' });
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

  await rejectsAsInvalid(service().verifyBearerToken(tampered));
  await rejectsAsInvalid(service().verifyBearerToken('not.a.jwt'));
  await rejectsAsInvalid(service().verifyBearerToken('x'.repeat(8_193)));
});

test('rejects a token signed with a different key', async () => {
  const token = await service().issue({ issuer: 'google', subject: 'user-1' });

  await rejectsAsInvalid(service(OTHER_KEY).verifyBearerToken(token));
});

test('rejects expired tokens', async () => {
  const now = Math.floor(Date.now() / 1_000) - 120;
  const token = await signRaw(
    { provider: 'google', sub: 'user-1', iat: now },
    { issuer: 'lingualoop', audience: 'lingualoop-api', expiresIn: 60 },
  );

  await rejectsAsInvalid(service().verifyBearerToken(token));
});

test('rejects correctly signed tokens without an expiration claim', async () => {
  const now = Math.floor(Date.now() / 1_000);
  const token = await signRaw(
    { provider: 'google', sub: 'user-1', iat: now },
    { issuer: 'lingualoop', audience: 'lingualoop-api' },
  );

  await rejectsAsInvalid(service().verifyBearerToken(token));
});

test('rejects correctly signed tokens without an issued-at claim', async () => {
  const exp = Math.floor(Date.now() / 1_000) + 900;
  const token = await signRaw(
    { provider: 'google', sub: 'user-1', exp },
    { issuer: 'lingualoop', audience: 'lingualoop-api', noTimestamp: true },
  );

  await rejectsAsInvalid(service().verifyBearerToken(token));
});

test('rejects correctly signed tokens with a lifetime longer than 15 minutes', async () => {
  const iat = Math.floor(Date.now() / 1_000);
  const token = await signRaw(
    { provider: 'google', sub: 'user-1', iat, exp: iat + 901 },
    { issuer: 'lingualoop', audience: 'lingualoop-api' },
  );

  await rejectsAsInvalid(service().verifyBearerToken(token));
});

test('rejects tokens with the wrong audience or issuer', async () => {
  const wrongAudience = await signRaw(
    { provider: 'google', sub: 'user-1' },
    { issuer: 'lingualoop', audience: 'another-api', expiresIn: 900 },
  );
  const wrongIssuer = await signRaw(
    { provider: 'google', sub: 'user-1' },
    { issuer: 'another-service', audience: 'lingualoop-api', expiresIn: 900 },
  );

  await rejectsAsInvalid(service().verifyBearerToken(wrongAudience));
  await rejectsAsInvalid(service().verifyBearerToken(wrongIssuer));
});

test('rejects tokens signed with a non-whitelisted algorithm', async () => {
  const token = await signRaw(
    { provider: 'google', sub: 'user-1' },
    { algorithm: 'HS384', issuer: 'lingualoop', audience: 'lingualoop-api', expiresIn: 900 },
  );

  await rejectsAsInvalid(service().verifyBearerToken(token));
});

test('rejects legacy NousAI-style claims even when signed with the same key', async () => {
  const token = await signRaw({ sub: 'user-1' }, { expiresIn: 900 });

  await rejectsAsInvalid(service().verifyBearerToken(token));
});

test('requires an independent signing key of at least 32 bytes', () => {
  assert.throws(() => new LinguaLoopTokenService(jwt, 'short-key'), TypeError);
  assert.throws(() => new LinguaLoopTokenService(jwt, Buffer.alloc(31)), TypeError);
  assert.doesNotThrow(() => new LinguaLoopTokenService(jwt, Buffer.alloc(32)));
});

test('rejects invalid provider identifiers and subjects before issuing', async () => {
  const tokens = service();
  const invalidInputs = [
    { issuer: '', subject: 'user-1' },
    { issuer: 'provider with spaces', subject: 'user-1' },
    { issuer: 'google', subject: '' },
    { issuer: 'google', subject: 'user with spaces' },
    { issuer: 'google', subject: 'user\nforged' },
    { issuer: 'google', subject: `user-${'x'.repeat(600)}` },
    { issuer: 'google', subject: '\ud800' },
    { issuer: 'google', subject: 'e\u0301' },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(tokens.issue(input), RangeError);
  }
});

test('rejects signed tokens whose provider or subject claims are malformed', async () => {
  for (const payload of [
    { provider: 'bad provider', sub: 'user-1' },
    { provider: 'google', sub: 'user with spaces' },
    { provider: 'google', sub: `user-${'x'.repeat(600)}` },
    { provider: 'google', sub: '\ud800' },
  ]) {
    const token = await signRaw(payload, {
      issuer: 'lingualoop',
      audience: 'lingualoop-api',
      expiresIn: 900,
    });
    await rejectsAsInvalid(service().verifyBearerToken(token));
  }
});
