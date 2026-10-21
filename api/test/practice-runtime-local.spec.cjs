const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');
const { loadPracticeRuntimeConfiguration, PracticeRuntimeHost } = require('../dist/language-practice/practice-runtime.providers');

const enabledEnv = (extra = {}) => ({
  LINGUALOOP_STT_ENABLED: 'true',
  LINGUALOOP_STT_START_MODE: 'managed',
  LINGUALOOP_STT_SERVER_URL: 'http://127.0.0.1:8080',
  LINGUALOOP_STT_PORT: '8080',
  LINGUALOOP_STT_MODEL: 'base.en',
  LINGUALOOP_STT_PYTHON: process.platform === 'win32' ? 'C:\\stt\\python.exe' : '/opt/stt/bin/python',
  LINGUALOOP_STT_CPU_THREADS: '4',
  LANGUAGE_PRACTICE_FFMPEG_PATH: process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : '/usr/bin/ffmpeg',
  ...extra,
});

test('STT is fixed to base.en INT8-ready CPU configuration with loopback/private Docker destinations only', () => {
  const config = loadPracticeRuntimeConfiguration(enabledEnv());
  assert.ok(config);
  assert.equal(config.model, 'base.en');
  assert.equal(config.cpuThreads, 4);
  assert.equal(config.startMode, 'managed');
  assert.equal(config.pythonExecutable, enabledEnv().LINGUALOOP_STT_PYTHON);
  assert.match(config.serverScript, /scripts[\\/]whisper-stt-server\.py$/);
  assert.equal(loadPracticeRuntimeConfiguration({ ...enabledEnv(), LINGUALOOP_STT_ENABLED: 'false' }), undefined);
  for (const env of [
    { ...enabledEnv(), LINGUALOOP_STT_MODEL: 'nemotron-3.5' },
    { ...enabledEnv(), LINGUALOOP_STT_SERVER_URL: 'https://example.com:443' },
    { ...enabledEnv(), LINGUALOOP_STT_SERVER_URL: 'http://localhost:8080' },
    { ...enabledEnv(), LINGUALOOP_STT_SERVER_URL: 'http://attacker.example:8080' },
    { ...enabledEnv(), LINGUALOOP_STT_PYTHON: '/opt/../python' },
  ]) assert.equal(loadPracticeRuntimeConfiguration(env), undefined);
});

test('remote external STT accepts only the private Docker DNS service', () => {
  const env = enabledEnv({
    LINGUALOOP_STT_START_MODE: 'external',
    LINGUALOOP_STT_SERVER_URL: 'http://stt:8080',
  });
  assert.equal(loadPracticeRuntimeConfiguration(env).startMode, 'external');
  assert.equal(loadPracticeRuntimeConfiguration({ ...env, LINGUALOOP_STT_SERVER_URL: 'http://public.example:8080' }), undefined);
  assert.equal(loadPracticeRuntimeConfiguration({ ...env, LINGUALOOP_STT_SERVER_URL: 'http://stt:8080/path' }), undefined);
});

test('STT stays lazy per turn, uploads audio only to loopback, and sends fixed English model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lingualoop-stt-test-'));
  const wav = join(directory, 'audio.wav');
  await writeFile(wav, Buffer.from('fake wav bytes'));
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:8080/v1/audio/transcriptions');
    assert.equal(init.method, 'POST');
    const form = init.body;
    assert.equal(form.get('model'), 'base.en');
    assert.equal(form.get('language'), 'en');
    assert.equal(form.get('file').type, 'audio/wav');
    return new Response(JSON.stringify({ text: 'hello world' }), { status: 200 });
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

test('external remote runtime waits for its ready endpoint without spawning a local process', async () => {
  const originalFetch = global.fetch;
  let url;
  global.fetch = async (input) => {
    url = String(input);
    return new Response(JSON.stringify({ ready: true, model: 'base.en' }), { status: 200 });
  };
  try {
    const config = loadPracticeRuntimeConfiguration(enabledEnv({
      LINGUALOOP_STT_START_MODE: 'external', LINGUALOOP_STT_SERVER_URL: 'http://stt:8080',
    }));
    const host = new PracticeRuntimeHost(config);
    await host.start();
    assert.equal(url, 'http://stt:8080/ready');
    assert.equal(host.sttProcess, undefined);
    await host.onApplicationShutdown();
  } finally { global.fetch = originalFetch; }
});
