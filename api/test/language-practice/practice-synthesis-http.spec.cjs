const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfiguredVerifiedRequestGuard } = require('../../dist/auth/google-auth.providers.js');
const { LinguaLoopTokenService } = require('../../dist/auth/lingualoop-token.service.js');
const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../../dist/auth/auth-store.providers.js');
const { InvalidBearerTokenError } = require('../../dist/auth/verified-request.guard.js');
const { PracticeSynthesisController } = require('../../dist/language-practice/practice-synthesis.controller.js');
const { PIPER_RUNTIME, loadPiperRuntimeConfiguration } = require('../../dist/language-practice/piper-runtime.providers.js');

const token = 'test-access-token';
const ownerId = '550e8400-e29b-41d4-a716-446655440000';
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const digest = 'a'.repeat(64);

function config() {
  return {
    LANGUAGE_PRACTICE_PIPER_PATH: '/runtime/piper',
    LANGUAGE_PRACTICE_PIPER_MODEL_EN: '/models/en.onnx',
    LANGUAGE_PRACTICE_PIPER_MODEL_ES: '/models/es.onnx',
    LINGUALOOP_PIPER_MODEL_EN_SHA256: digest,
    LINGUALOOP_PIPER_SIDECAR_EN_SHA256: digest,
    LINGUALOOP_PIPER_MODEL_ES_SHA256: digest,
    LINGUALOOP_PIPER_SIDECAR_ES_SHA256: digest,
  };
}

test('Piper configuration requires exact absolute paths and all four lowercase SHA-256 pins', () => {
  const valid = loadPiperRuntimeConfiguration(config());
  assert.equal(valid.en.modelPath, '/models/en.onnx');
  assert.equal(valid.es.sidecarSha256, digest);
  for (const key of Object.keys(config())) {
    const invalid = config();
    delete invalid[key];
    assert.equal(loadPiperRuntimeConfiguration(invalid), undefined, `${key} is required`);
  }
  assert.equal(loadPiperRuntimeConfiguration({ ...config(), LANGUAGE_PRACTICE_PIPER_PATH: '/runtime/../piper' }), undefined);
  assert.equal(loadPiperRuntimeConfiguration({ ...config(), LINGUALOOP_PIPER_MODEL_ES_SHA256: 'A'.repeat(64) }), undefined);
});

async function createServer(t, { hold = false } = {}) {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const host = { async synthesize(text) {
    calls.push(text);
    if (hold) { started(); await held; }
    return Buffer.from('validated-wav');
  } };
  class TestModule {}
  Module({
    controllers: [PracticeSynthesisController],
    providers: [
      { provide: PIPER_RUNTIME, useValue: { getHost(voice) { calls.push(`voice:${voice}`); return host; } } },
      { provide: LinguaLoopTokenService, useValue: { async verifyBearerToken(value) {
        if (value !== token) throw new InvalidBearerTokenError();
        return { issuer: 'local', subject: ownerId, sessionId };
      } } },
      { provide: LINGUALOOP_IDENTITY_STORE, useValue: { async findOwnerByIdentity() { return ownerId; }, async findAccountByOwner() { return { name: 'Student', email: 'student@example.test', role: 'student' }; } } },
      { provide: LINGUALOOP_SESSION_STORE, useValue: { async isSessionActive(owner, session) { return owner === ownerId && session === sessionId; } } },
      ConfiguredVerifiedRequestGuard,
      require('../../dist/auth/role.guard.js').RoleGuard,
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(async () => { release(); await app.close(); });
  const address = app.getHttpServer().address();
  return { base: `http://127.0.0.1:${address.port}`, calls, startedPromise, release };
}

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

test('synthesis requires a verified bearer and ignores caller-supplied identity', async (t) => {
  const { base, calls } = await createServer(t);
  const response = await fetch(`${base}/practice/synthesize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'en', text: 'hello', ownerId, sessionId }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('rejects malformed, unknown, oversized, or control-character input without synthesis', async (t) => {
  const { base, calls } = await createServer(t);
  for (const body of [
    { language: 'fr', text: 'hello' }, { language: 'en', text: '   ' },
    { language: 'en', text: 'hello', extra: true }, { language: 'en', text: 'line\nbreak' },
    { language: 'en', text: 'x'.repeat(501) },
  ]) {
    const response = await fetch(`${base}/practice/synthesize`, { method: 'POST', headers, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(result, { error: 'Speech synthesis could not be completed.' });
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  }
  assert.equal(calls.length, 0);
});

test('Nest JSON parser rejects payloads above its 100 KiB default before synthesis', async (t) => {
  const { base, calls } = await createServer(t);
  const response = await fetch(`${base}/practice/synthesize`, {
    method: 'POST', headers, body: JSON.stringify({ language: 'en', text: 'x'.repeat(110 * 1024) }),
  });
  const result = await response.json();
  assert.equal(response.status, 413);
  // The Nest JSON parser rejects this before the controller can apply its error envelope.
  assert.deepEqual(result, { statusCode: 413, message: 'request entity too large' });
  assert.equal(calls.length, 0);
});

test('returns only the host WAV with safe headers and allows one active synthesis', async (t) => {
  const { base, calls, startedPromise, release } = await createServer(t, { hold: true });
  const first = fetch(`${base}/practice/synthesize`, { method: 'POST', headers, body: JSON.stringify({ language: 'es', text: 'hola' }) });
  await startedPromise;
  const busy = await fetch(`${base}/practice/synthesize`, { method: 'POST', headers, body: JSON.stringify({ language: 'en', text: 'hello' }) });
  assert.equal(busy.status, 429);
  assert.deepEqual(await busy.json(), { error: 'Speech synthesis could not be completed.' });
  release();
  const response = await first;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal((await response.arrayBuffer()).byteLength, Buffer.byteLength('validated-wav'));
  assert.deepEqual(calls, ['voice:es', 'hola']);
});
