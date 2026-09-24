const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { AuthSession } = require('../src/auth-session.ts');
const synthesis = require('../src/practice-synthesis.ts');

function wavBytes() {
  const bytes = new Uint8Array(48);
  bytes.set([82, 73, 70, 70], 0);
  bytes.set([87, 65, 86, 69], 8);
  return bytes;
}

function response(body, status = 200, headers = { 'content-type': 'audio/wav' }) {
  return new Response(body, { status, headers });
}

async function authenticatedSession(request) {
  const session = new AuthSession(request);
  assert.equal(await session.refresh(), 'authenticated');
  return session;
}

test('text validation applies character, UTF-8 byte, blank, and control-character limits', () => {
  assert.equal(synthesis.validateSynthesisText('a'.repeat(500)), null);
  assert.equal(synthesis.validateSynthesisText('😀'.repeat(250)), null);
  assert.equal(synthesis.validateSynthesisText('😀'.repeat(251)), 'invalid-text');
  assert.equal(synthesis.validateSynthesisText('a'.repeat(2001)), 'invalid-text');
  assert.equal(synthesis.validateSynthesisText(' \t '), 'invalid-text');
  assert.equal(synthesis.validateSynthesisText('hello\nthere'), 'invalid-text');
});

test('accepts only bounded WAV blobs with the RIFF/WAVE signature', async () => {
  assert.equal(await synthesis.validateWavBlob(new Blob([wavBytes()], { type: 'audio/wav' })), true);
  assert.equal(await synthesis.validateWavBlob(new Blob([wavBytes()], { type: 'audio/mpeg' })), false);
  const invalidHeader = wavBytes();
  invalidHeader[0] = 0;
  assert.equal(await synthesis.validateWavBlob(new Blob([invalidHeader], { type: 'audio/wav' })), false);
  assert.equal(await synthesis.validateWavBlob(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], { type: 'audio/wav' })), false);
});

test('synthesizes with the volatile bearer, refreshes once on 401, and accepts validated audio', async () => {
  const requests = [];
  const session = new AuthSession(async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/auth/refresh') return response(JSON.stringify({ accessToken: 'volatile-token' }), 200, { 'content-type': 'application/json' });
    if (requests.filter((item) => item.url === '/api/practice/synthesize').length === 1) return response('', 401);
    return response(wavBytes());
  });
  assert.equal(await session.refresh(), 'authenticated');
  const result = await session.synthesize('es', 'buenos días');
  assert.equal(result.ok, true);
  assert.equal(result.wav.type, 'audio/wav');
  const synthesisCalls = requests.filter((item) => item.url === '/api/practice/synthesize');
  assert.equal(synthesisCalls.length, 2);
  assert.equal(synthesisCalls[0].options.headers.Authorization, 'Bearer volatile-token');
  assert.equal(synthesisCalls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(synthesisCalls[0].options.body), { language: 'es', text: 'buenos días' });
  assert.equal(synthesisCalls.some((item) => item.url.includes('volatile-token')), false);
});

test('maps missing and unavailable endpoints without exposing response bodies', async () => {
  for (const [status, expected] of [[404, 'not-found'], [503, 'unavailable']]) {
    const session = await authenticatedSession(async (url) => url === '/api/auth/refresh'
      ? response(JSON.stringify({ accessToken: 'token' }), 200, { 'content-type': 'application/json' })
      : response('secret error detail', status));
    assert.deepEqual(await session.synthesize('en', 'hello'), { ok: false, error: expected });
  }
});

test('rejects wrong MIME, invalid WAV, and oversized declared body', async () => {
  const cases = [
    response(wavBytes(), 200, { 'content-type': 'application/json' }),
    response(new Uint8Array(48), 200, { 'content-type': 'audio/wav' }),
    response(wavBytes(), 200, { 'content-type': 'audio/wav', 'content-length': String(8 * 1024 * 1024 + 1) }),
  ];
  for (const audioResponse of cases) {
    const session = await authenticatedSession(async (url) => url === '/api/auth/refresh'
      ? response(JSON.stringify({ accessToken: 'token' }), 200, { 'content-type': 'application/json' })
      : audioResponse);
    assert.deepEqual(await session.synthesize('en', 'hello'), { ok: false, error: 'failed' });
  }
});

test('audio cleanup pauses, clears the source, reloads, and revokes the object URL', () => {
  const calls = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => calls.push(`revoke:${url}`);
  try {
    synthesis.releaseAudio({ pause: () => calls.push('pause'), removeAttribute: (name) => calls.push(`remove:${name}`), load: () => calls.push('load') }, 'blob:private-audio');
  } finally {
    URL.revokeObjectURL = original;
  }
  assert.deepEqual(calls, ['pause', 'remove:src', 'load', 'revoke:blob:private-audio']);
});
