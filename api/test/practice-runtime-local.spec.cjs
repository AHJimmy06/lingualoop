const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');
const { loadPracticeRuntimeConfiguration, PracticeRuntimeHost } = require('../dist/language-practice/practice-runtime.providers');

const enabledEnv = () => ({
  LINGUALOOP_STT_ENABLED: 'true',
  LINGUALOOP_STT_SERVER_URL: 'http://127.0.0.1:8080',
  LINGUALOOP_STT_PORT: '8080',
  LINGUALOOP_STT_MODEL: 'nemotron-3.5',
  LINGUALOOP_STT_EXECUTABLE: process.platform === 'win32' ? 'C:\\nemo\\nemo-speech.exe' : '/usr/bin/nemo-speech',
  LANGUAGE_PRACTICE_FFMPEG_PATH: process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : '/usr/bin/ffmpeg',
});

test('local NeMo configuration is explicit and rejects non-loopback uploads', () => {
  const config = loadPracticeRuntimeConfiguration(enabledEnv());
  assert.equal(config.serverUrl, 'http://127.0.0.1:8080');
  assert.equal(config.model, 'nemotron-3.5');
  assert.equal(loadPracticeRuntimeConfiguration({ ...enabledEnv(), LINGUALOOP_STT_ENABLED: 'false' }), undefined);
  assert.equal(loadPracticeRuntimeConfiguration({ ...enabledEnv(), LINGUALOOP_STT_SERVER_URL: 'https://example.com:443' }), undefined);
  assert.equal(loadPracticeRuntimeConfiguration({ ...enabledEnv(), LINGUALOOP_STT_SERVER_URL: 'http://localhost:8080' }), undefined);
});

test('local STT host makes no request until transcribe and uploads a WAV only to loopback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lingualoop-stt-test-'));
  const wav = join(directory, 'audio.wav');
  await writeFile(wav, Buffer.from('fake wav bytes'));
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url, init) => {
    calls += 1;
    assert.equal(url, 'http://127.0.0.1:8080/v1/audio/transcriptions');
    assert.equal(init.method, 'POST');
    const form = init.body;
    assert.equal(form.get('model'), 'default');
    assert.equal(form.get('language'), 'auto');
    assert.equal(form.get('file').type, 'audio/wav');
    return new Response(JSON.stringify({ text: 'hello world' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const host = new PracticeRuntimeHost(loadPracticeRuntimeConfiguration(enabledEnv()));
    const stt = host.getHost();
    assert.equal(calls, 0);
    assert.equal(await stt.transcribe(resolve(wav)), 'hello world');
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
