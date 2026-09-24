const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpException } = require('@nestjs/common');
const {
  InvalidBearerTokenError,
  VerifiedRequestGuard,
} = require('../dist/auth/verified-request.guard.js');

const IDENTITY = {
  issuer: 'google',
  subject: 'user-42',
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
};
const OWNER = '550e8400-e29b-41d4-a716-446655440000';

function executionContext(authorization, extraHeaders = {}) {
  const request = {
    headers: { ...extraHeaders },
    verifiedIdentity: { issuer: 'client', subject: 'forged', sessionId: IDENTITY.sessionId, ownerId: OWNER },
    subject: 'client-supplied-subject',
  };
  if (authorization !== undefined) request.headers.authorization = authorization;
  return {
    request,
    context: { switchToHttp: () => ({ getRequest: () => request }) },
  };
}

function dependencies(overrides = {}) {
  return {
    verifier: { verifyBearerToken: async () => IDENTITY },
    ownerLookup: { findOwnerByIdentity: async () => OWNER },
    sessionChecker: { isSessionActive: async () => true },
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

function guard(overrides = {}) {
  const deps = dependencies(overrides);
  return new VerifiedRequestGuard(deps.verifier, deps.ownerLookup, deps.sessionChecker, deps.nowMs);
}

test('verifies token, resolves provider owner, checks session, and attaches only validated identity', async () => {
  let verifiedToken;
  let ownerIdentity;
  let sessionArguments;
  const instance = guard({
    verifier: { verifyBearerToken: async token => { verifiedToken = token; return IDENTITY; } },
    ownerLookup: { findOwnerByIdentity: async identity => { ownerIdentity = identity; return OWNER; } },
    sessionChecker: { isSessionActive: async (...args) => { sessionArguments = args; return true; } },
  });
  const { request, context } = executionContext('Bearer token-value');

  assert.equal(await instance.canActivate(context), true);
  assert.equal(verifiedToken, 'token-value');
  assert.deepEqual(ownerIdentity, { issuer: 'google', subject: 'user-42' });
  assert.deepEqual(sessionArguments, [OWNER, IDENTITY.sessionId, 1_700_000_000_000]);
  assert.deepEqual(request.verifiedIdentity, { ...IDENTITY, ownerId: OWNER });
  assert.equal(request.subject, 'client-supplied-subject');
});

test('rejects missing, malformed, whitespace, and CRLF authorization without attaching identity', async () => {
  const instance = guard();
  for (const authorization of [
    undefined, '', 'Basic token-value', 'Bearer', 'Bearer  token-value',
    ' Bearer token-value', 'Bearer token-value ', 'Bearer token value',
    'Bearer token\r\nX-Injected: yes',
  ]) {
    const { request, context } = executionContext(authorization);
    await assert.rejects(instance.canActivate(context), { status: 401 });
    assert.equal(request.verifiedIdentity, undefined);
  }
});

test('rejects array and duplicate Authorization headers without verification or lookup', async () => {
  let called = false;
  const instance = guard({
    verifier: { verifyBearerToken: async () => { called = true; return IDENTITY; } },
  });
  const cases = [
    executionContext(['Bearer first', 'Bearer second']),
    (() => {
      const value = executionContext('Bearer first');
      value.request.rawHeaders = ['Authorization', 'Bearer first', 'authorization', 'Bearer second'];
      return value;
    })(),
  ];
  for (const { request, context } of cases) {
    await assert.rejects(instance.canActivate(context), { status: 401 });
    assert.equal(request.verifiedIdentity, undefined);
  }
  assert.equal(called, false);
});

test('invalid bearer never performs owner or session lookup; verifier infrastructure errors fail closed', async () => {
  let ownerLookups = 0;
  let sessionLookups = 0;
  for (const [verifyBearerToken, expectedStatus] of [
    [async () => { throw new InvalidBearerTokenError(); }, 401],
    [async () => { throw new Error('private verifier detail'); }, 503],
  ]) {
    const instance = guard({
      verifier: { verifyBearerToken },
      ownerLookup: { findOwnerByIdentity: async () => { ownerLookups++; return OWNER; } },
      sessionChecker: { isSessionActive: async () => { sessionLookups++; return true; } },
    });
    const { request, context } = executionContext('Bearer token-value');
    await assert.rejects(instance.canActivate(context), error => error.status === expectedStatus && !error.message.includes('private'));
    assert.equal(request.verifiedIdentity, undefined);
  }
  assert.equal(ownerLookups, 0);
  assert.equal(sessionLookups, 0);
});

test('returns 503 for unavailable dependencies and malformed verifier or store records', async () => {
  const unavailable = new VerifiedRequestGuard(undefined, dependencies().ownerLookup, dependencies().sessionChecker);
  const missingRequest = executionContext('Bearer token-value');
  await assert.rejects(unavailable.canActivate(missingRequest.context), { status: 503 });
  assert.equal(missingRequest.request.verifiedIdentity, undefined);

  for (const identity of [
    null, {}, { ...IDENTITY, issuer: 'other' }, { ...IDENTITY, subject: ' ' },
    { ...IDENTITY, subject: 'a'.repeat(513) }, { ...IDENTITY, sessionId: 'not-a-uuid' },
    { ...IDENTITY, sessionId: '123e4567-e89b-12d3-a456-426614174000' },
  ]) {
    const { request, context } = executionContext('Bearer token-value');
    await assert.rejects(guard({ verifier: { verifyBearerToken: async () => identity } }).canActivate(context), { status: 503 });
    assert.equal(request.verifiedIdentity, undefined);
  }
  for (const ownerId of [undefined, {}, 'not-a-uuid']) {
    const { request, context } = executionContext('Bearer token-value');
    await assert.rejects(guard({ ownerLookup: { findOwnerByIdentity: async () => ownerId } }).canActivate(context), { status: 503 });
    assert.equal(request.verifiedIdentity, undefined);
  }
});

test('owner-scopes session UUIDs and denies unknown, stolen, revoked, and expired sessions', async () => {
  const ownerA = OWNER;
  const ownerB = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  let lookups = 0;
  const ownerScoped = guard({
    ownerLookup: { findOwnerByIdentity: async identity => { lookups++; assert.equal(identity.subject, IDENTITY.subject); return ownerA; } },
    sessionChecker: { isSessionActive: async (ownerId, sid) => ownerId === ownerB && sid === IDENTITY.sessionId },
  });
  const { request, context } = executionContext('Bearer token-value');
  await assert.rejects(ownerScoped.canActivate(context), { status: 401 });
  assert.equal(request.verifiedIdentity, undefined);
  assert.equal(lookups, 1);

  for (const [ownerLookup, sessionChecker] of [
    [{ findOwnerByIdentity: async () => null }, { isSessionActive: async () => { throw Error('must not run'); } }],
    [{ findOwnerByIdentity: async () => ownerB }, { isSessionActive: async ownerId => ownerId === ownerA }],
    [{ findOwnerByIdentity: async () => ownerA }, { isSessionActive: async () => false }],
  ]) {
    const attempt = executionContext('Bearer token-value');
    await assert.rejects(guard({ ownerLookup, sessionChecker }).canActivate(attempt.context), { status: 401 });
    assert.equal(attempt.request.verifiedIdentity, undefined);
  }
});

test('checks current time on every authorization and permits reuse only while the session is active', async () => {
  let currentTime = 100;
  let verified = 0;
  const checkedAt = [];
  const instance = guard({
    verifier: { verifyBearerToken: async () => { verified++; return IDENTITY; } },
    nowMs: () => currentTime,
    sessionChecker: { isSessionActive: async (_owner, _sid, nowMs) => { checkedAt.push(nowMs); return nowMs < 200; } },
  });

  const first = executionContext('Bearer same-token');
  assert.equal(await instance.canActivate(first.context), true);
  const second = executionContext('Bearer same-token');
  assert.equal(await instance.canActivate(second.context), true);
  currentTime = 200;
  const expired = executionContext('Bearer same-token');
  await assert.rejects(instance.canActivate(expired.context), { status: 401 });
  assert.equal(expired.request.verifiedIdentity, undefined);
  assert.equal(verified, 3);
  assert.deepEqual(checkedAt, [100, 100, 200]);
});

test('maps owner and session database failures to sanitized 503 responses', async () => {
  for (const override of [
    { ownerLookup: { findOwnerByIdentity: async () => { throw Error('private owner database detail'); } } },
    { sessionChecker: { isSessionActive: async () => { throw Error('private session database detail'); } } },
    { ownerLookup: { findOwnerByIdentity: async () => { throw new HttpException('private DB details', 418); } } },
    { sessionChecker: { isSessionActive: async () => { throw new HttpException('private DB details', 418); } } },
  ]) {
    const { request, context } = executionContext('Bearer token-value');
    await assert.rejects(guard(override).canActivate(context), error =>
      error.status === 503 && error.message === 'Authentication service unavailable.');
    assert.equal(request.verifiedIdentity, undefined);
  }
});
