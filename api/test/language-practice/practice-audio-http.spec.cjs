const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfiguredVerifiedRequestGuard } = require('../../dist/auth/google-auth.providers.js');
const { LinguaLoopTokenService } = require('../../dist/auth/lingualoop-token.service.js');
const { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE } = require('../../dist/auth/auth-store.providers.js');
const { InvalidBearerTokenError } = require('../../dist/auth/verified-request.guard.js');
const { PracticeAudioController } = require('../../dist/language-practice/practice-audio.controller.js');
const { PRACTICE_AUDIO_PREPARER, PracticeAudioService } = require('../../dist/language-practice/practice-audio.service.js');
const { PRACTICE_RUNTIME, PRACTICE_FFMPEG_PATH } = require('../../dist/language-practice/practice-runtime.providers.js');

const token = 'test-access-token';
const ownerId = '550e8400-e29b-41d4-a716-446655440000';
const sessionId = '123e4567-e89b-42d3-a456-426614174000';

async function createServer(t, { prepare } = {}) {
  const calls = { prepare: 0, transcribe: 0, wavPaths: [] };
  const fakePrepare = prepare ?? (async (_input, _mime, callback) => {
    calls.prepare += 1;
    return callback('/private/prepared.wav');
  });
  const host = { async transcribe(path) {
    calls.transcribe += 1;
    calls.wavPaths.push(path);
    return 'Hello, this is a safe transcript.';
  } };
  class TestModule {}
  Module({
    controllers: [PracticeAudioController],
    providers: [
      PracticeAudioService,
      { provide: PRACTICE_AUDIO_PREPARER, useValue: fakePrepare },
      { provide: PRACTICE_FFMPEG_PATH, useValue: '/fake/ffmpeg' },
      { provide: PRACTICE_RUNTIME, useValue: { getHost: () => host } },
      { provide: LinguaLoopTokenService, useValue: { async verifyBearerToken(value) {
        if (value !== token) throw new InvalidBearerTokenError();
        return { issuer: 'google', subject: 'verified-subject', sessionId };
      } } },
      { provide: LINGUALOOP_IDENTITY_STORE, useValue: { async findOwnerByIdentity() { return ownerId; } } },
      { provide: LINGUALOOP_SESSION_STORE, useValue: { async isSessionActive(owner, session) { return owner === ownerId && session === sessionId; } } },
      ConfiguredVerifiedRequestGuard,
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address();
  return { base: `http://127.0.0.1:${address.port}`, calls };
}

function headers(extra = {}) {
  return { authorization: `Bearer ${token}`, 'content-type': 'audio/webm', ...extra };
}

function rawRequest(base, { headers: requestHeaders, chunks = [] }) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}/practice/transcribe`, { method: 'POST', headers: requestHeaders }, (response) => {
      const received = [];
      response.on('data', (chunk) => received.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(received).toString() }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('disconnect before the first body chunk settles the bounded body reader', async () => {
  let transcribeCalls = 0;
  const controller = new PracticeAudioController({ async transcribe() { transcribeCalls += 1; return 'unused'; } });
  const request = new EventEmitter();
  request.headers = { 'content-type': 'audio/webm' };
  request.verifiedIdentity = { ownerId, sessionId };
  request.resume = () => {};
  const response = {
    headersSent: false,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; },
  };
  const pending = controller.transcribe(request, response);
  request.emit('close');
  let timer;
  await Promise.race([pending, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Body reader remained pending after close')), 100);
  })]);
  clearTimeout(timer);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'Audio transcription could not be completed.' });
  assert.equal(transcribeCalls, 0);
});

test('transcription requires the verified bearer and does not call audio providers when unauthorized', async (t) => {
  const { base, calls } = await createServer(t);
  const response = await fetch(`${base}/practice/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'audio/webm', cookie: `owner=${ownerId}; session=${sessionId}` },
    body: JSON.stringify({ ownerId, sessionId }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls.prepare, 0);
  assert.equal(calls.transcribe, 0);
});

test('rejects unsupported MIME and declared oversized body before preparation', async (t) => {
  const { base, calls } = await createServer(t);
  const mime = await fetch(`${base}/practice/transcribe`, { method: 'POST', headers: headers({ 'content-type': 'multipart/form-data; boundary=x' }), body: 'payload' });
  assert.equal(mime.status, 415);
  const oversized = await rawRequest(base, { headers: headers({ 'content-length': String(2 * 1024 * 1024 + 1) }) });
  assert.equal(oversized.status, 413);
  assert.equal(calls.prepare, 0);
});

test('rejects streamed body over 2 MiB without invoking preparation', async (t) => {
  const { base, calls } = await createServer(t);
  const response = await rawRequest(base, {
    headers: headers({ 'transfer-encoding': 'chunked' }),
    chunks: [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024), Buffer.alloc(1)],
  });
  assert.equal(response.status, 413);
  assert.equal(calls.prepare, 0);
});

test('allows only one active preparation/transcription and returns one safe transcript', async (t) => {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const { base, calls } = await createServer(t, {
    async prepare(_input, _mime, callback) {
      calls.prepare += 1;
      markStarted();
      await held;
      return callback('/private/prepared.wav');
    },
  });
  const first = fetch(`${base}/practice/transcribe`, { method: 'POST', headers: headers(), body: 'bounded-audio' });
  await started;
  const competing = await fetch(`${base}/practice/transcribe`, { method: 'POST', headers: headers(), body: 'second-audio' });
  assert.equal(competing.status, 429);
  release();
  const response = await first;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { transcript: 'Hello, this is a safe transcript.' });
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(calls.wavPaths, ['/private/prepared.wav']);
  assert.equal(calls.transcribe, 1);
});

test('releases the processing slot when preparation/transcription fails', async (t) => {
  let fail = true;
  const { base, calls } = await createServer(t, {
    async prepare(_input, _mime, callback) {
      calls.prepare += 1;
      if (fail) { fail = false; throw new Error('private detail'); }
      return callback('/private/prepared.wav');
    },
  });
  const failed = await fetch(`${base}/practice/transcribe`, { method: 'POST', headers: headers(), body: 'audio' });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private detail/);
  const recovered = await fetch(`${base}/practice/transcribe`, { method: 'POST', headers: headers(), body: 'audio' });
  assert.equal(recovered.status, 200);
  assert.equal(calls.transcribe, 1);
});
