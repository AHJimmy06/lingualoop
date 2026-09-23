const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InvalidBearerTokenError,
  VerifiedRequestGuard,
} = require('../dist/auth/verified-request.guard.js');

const IDENTITY = { issuer: 'example-provider', subject: 'user-42' };

function executionContext(authorization, extraHeaders = {}) {
  const request = {
    headers: { ...extraHeaders },
    verifiedIdentity: { issuer: 'client', subject: 'forged' },
    subject: 'client-supplied-subject',
  };
  if (authorization !== undefined) request.headers.authorization = authorization;
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
    },
  };
}

test('verifies exactly one Bearer token and attaches only the validated identity', async () => {
  let verifiedToken;
  const guard = new VerifiedRequestGuard({
    verifyBearerToken: async token => {
      verifiedToken = token;
      return IDENTITY;
    },
  });
  const { request, context } = executionContext('Bearer token-value');

  assert.equal(await guard.canActivate(context), true);
  assert.equal(verifiedToken, 'token-value');
  assert.deepEqual(request.verifiedIdentity, IDENTITY);
  assert.equal(request.subject, 'client-supplied-subject');
});

test('rejects missing, malformed, whitespace, and CRLF authorization without attaching identity', async () => {
  const guard = new VerifiedRequestGuard({ verifyBearerToken: async () => IDENTITY });
  for (const authorization of [
    undefined,
    '',
    'Basic token-value',
    'Bearer',
    'Bearer  token-value',
    ' Bearer token-value',
    'Bearer token-value ',
    'Bearer token value',
    'Bearer token\r\nX-Injected: yes',
  ]) {
    const { request, context } = executionContext(authorization);
    await assert.rejects(guard.canActivate(context), { status: 401 });
    assert.equal(request.verifiedIdentity, undefined);
  }
});

test('rejects array and duplicate Authorization headers without verification or identity attachment', async () => {
  let called = false;
  const guard = new VerifiedRequestGuard({ verifyBearerToken: async () => { called = true; return IDENTITY; } });
  const cases = [
    executionContext(['Bearer first', 'Bearer second']),
    (() => {
      const value = executionContext('Bearer first');
      value.request.rawHeaders = ['Authorization', 'Bearer first', 'authorization', 'Bearer second'];
      return value;
    })(),
  ];
  for (const { request, context } of cases) {
    await assert.rejects(guard.canActivate(context), { status: 401 });
    assert.equal(request.verifiedIdentity, undefined);
  }
  assert.equal(called, false);
});

test('maps invalid credentials to 401 and verifier failures to 503 without attaching identity', async () => {
  for (const [verifier, expectedStatus] of [
    [async () => { throw new InvalidBearerTokenError(); }, 401],
    [async () => { throw new Error('private verifier detail'); }, 503],
  ]) {
    const guard = new VerifiedRequestGuard({ verifyBearerToken: verifier });
    const { request, context } = executionContext('Bearer token-value');
    await assert.rejects(guard.canActivate(context), { status: expectedStatus });
    assert.equal(request.verifiedIdentity, undefined);
  }
});

test('returns 503 when verifier is unavailable and rejects malformed verifier identities', async () => {
  const unavailable = new VerifiedRequestGuard(undefined);
  const unavailableRequest = executionContext('Bearer token-value');
  await assert.rejects(unavailable.canActivate(unavailableRequest.context), { status: 503 });
  assert.equal(unavailableRequest.request.verifiedIdentity, undefined);

  for (const identity of [null, {}, { issuer: '', subject: 'user-42' }, { issuer: 'issuer', subject: ' ' }]) {
    const guard = new VerifiedRequestGuard({ verifyBearerToken: async () => identity });
    const { request, context } = executionContext('Bearer token-value');
    await assert.rejects(guard.canActivate(context), { status: 503 });
    assert.equal(request.verifiedIdentity, undefined);
  }
});
