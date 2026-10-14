const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IdentityServiceUnavailableError,
  InvalidCredentialError,
  NousAIIdentityService,
} = require('../dist/auth/nousai-identity.service.js');

const PROFILE_URL = 'https://nousai.example/api/auth/profile';
const VALID_TOKEN = 'header.payload.signature';

function jsonResponse(status, value) {
  return {
    status,
    json: async () => value,
  };
}

function service(fetcher, timeoutMs) {
  return new NousAIIdentityService(PROFILE_URL, fetcher, timeoutMs);
}

test('validates a Bearer token through the configured profile endpoint and returns canonical identity', async () => {
  let request;
  const client = service(async (url, init) => {
    request = { url, init };
    return jsonResponse(200, { success: true, data: { id: 42, isActive: true, name: 'User' } });
  });

  assert.deepEqual(await client.verifyBearerToken(VALID_TOKEN), {
    issuer: 'nousai',
    subject: '42',
  });
  assert.equal(String(request.url), PROFILE_URL);
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers.Authorization, `Bearer ${VALID_TOKEN}`);
  assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal instanceof AbortSignal);
});

test('fails closed unless the profile URL uses the exact endpoint and an allowed transport', () => {
  assert.throws(() => new NousAIIdentityService(undefined), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('/api/auth/profile'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('file:///etc/passwd'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('https://user:pass@example.test/api/auth/profile'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('https://example.test/profile'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('https://example.test/api/auth/profile/'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('https://example.test/api/auth/profile?'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('https://example.test/api/auth/profile?next=/'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('https://example.test/api/auth/profile#'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('https://example.test/api/auth/profile#fragment'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('http://example.test/api/auth/profile'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('http://10.0.0.8/api/auth/profile'), IdentityServiceUnavailableError);
  assert.throws(() => new NousAIIdentityService('http://[::1]/api/auth/profile'), IdentityServiceUnavailableError);

  assert.doesNotThrow(() => new NousAIIdentityService('https://example.test/api/auth/profile'));
  assert.doesNotThrow(() => new NousAIIdentityService('http://localhost/api/auth/profile'));
  assert.doesNotThrow(() => new NousAIIdentityService('http://127.0.0.1:3400/api/auth/profile'));
});

test('rejects empty, oversized, malformed, and CRLF credentials before making a request', async () => {
  let called = false;
  const client = service(async () => {
    called = true;
    return jsonResponse(200, {});
  });

  for (const token of [
    '',
    ' '.repeat(20),
    `${'a'.repeat(8_192)}.b.c`,
    'not-a-jwt',
    'header.payload',
    'header.payload.signature\r\nX-Injected: yes',
    'header.payload.signature\n',
  ]) {
    await assert.rejects(client.verifyBearerToken(token), InvalidCredentialError);
  }
  assert.equal(called, false);
});

test('classifies unauthorized responses and inactive profiles as invalid credentials', async () => {
  await assert.rejects(
    service(async () => jsonResponse(401, { error: 'do not expose' })).verifyBearerToken(VALID_TOKEN),
    InvalidCredentialError,
  );
  await assert.rejects(
    service(async () => jsonResponse(200, { success: true, data: { id: 42, isActive: false } })).verifyBearerToken(VALID_TOKEN),
    InvalidCredentialError,
  );
});

test('classifies non-200 and malformed profile responses as service failures', async () => {
  await assert.rejects(
    service(async () => jsonResponse(503, { error: 'private upstream detail' })).verifyBearerToken(VALID_TOKEN),
    IdentityServiceUnavailableError,
  );
  for (const body of [
    null,
    { success: false, data: { id: 42, isActive: true } },
    { success: true, data: { id: 42.5, isActive: true } },
    { success: true, data: { id: '42', isActive: true } },
    { success: true, data: { id: 42, isActive: 'true' } },
    { success: true, data: { id: 0, isActive: true } },
    { success: true, data: { id: -1, isActive: true } },
    { success: true, data: { id: Number.MAX_SAFE_INTEGER + 1, isActive: true } },
    { success: true, data: { id: Number.MAX_VALUE, isActive: true } },
  ]) {
    await assert.rejects(
      service(async () => jsonResponse(200, body)).verifyBearerToken(VALID_TOKEN),
      IdentityServiceUnavailableError,
    );
  }
});

test('classifies network errors and timed-out requests as service failures', async () => {
  await assert.rejects(
    service(async () => { throw new Error('private network detail'); }).verifyBearerToken(VALID_TOKEN),
    IdentityServiceUnavailableError,
  );

  const timeoutFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  await assert.rejects(
    service(timeoutFetch, 5).verifyBearerToken(VALID_TOKEN),
    IdentityServiceUnavailableError,
  );
});
