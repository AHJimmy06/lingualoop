const test = require('node:test');
const assert = require('node:assert/strict');
const windows = process.platform === 'win32';
const {
  PRACTICE_FFMPEG_PATH,
  PRACTICE_RUNTIME,
  PracticeRuntimeHost,
  createPracticeRuntimeProviders,
  loadPracticeRuntimeConfiguration,
} = require('../../dist/language-practice/practice-runtime.providers.js');

const validEnv = {
  LINGUALOOP_STT_ENABLED: 'true',
  LINGUALOOP_STT_START_MODE: 'managed',
  LINGUALOOP_STT_SERVER_URL: 'http://127.0.0.1:8080',
  LINGUALOOP_STT_PORT: '8080',
  LINGUALOOP_STT_MODEL: 'base.en',
  LINGUALOOP_STT_PYTHON: windows ? 'C:\\lingualoop\\venv\\Scripts\\python.exe' : '/opt/lingualoop/venv/bin/python',
  LINGUALOOP_STT_CPU_THREADS: '4',
  LANGUAGE_PRACTICE_FFMPEG_PATH: windows ? 'C:\\ffmpeg\\ffmpeg.exe' : '/usr/bin/ffmpeg',
};

test('practice runtime accepts only the fixed CPU Whisper model and complete local config', () => {
  const configuration = loadPracticeRuntimeConfiguration(validEnv);
  assert.ok(configuration);
  assert.equal(configuration.pythonExecutable, validEnv.LINGUALOOP_STT_PYTHON);
  assert.equal(configuration.ffmpegExecutable, validEnv.LANGUAGE_PRACTICE_FFMPEG_PATH);
  assert.equal(configuration.model, 'base.en');
  assert.match(configuration.serverScript, /scripts[\\/]whisper-stt-server\.py$/);

  for (const env of [
    {},
    { ...validEnv, LINGUALOOP_STT_PYTHON: 'python' },
    { ...validEnv, LINGUALOOP_STT_PYTHON: windows ? 'C:\\opt\\..\\python.exe' : '/opt/../python' },
    { ...validEnv, LINGUALOOP_STT_PYTHON: windows ? 'C:\\opt\\bad\0hidden.exe' : '/opt/python\0hidden' },
    { ...validEnv, LINGUALOOP_STT_MODEL: 'nemotron-3.5' },
  ]) {
    assert.equal(loadPracticeRuntimeConfiguration(env), undefined);
  }
});

test('practice providers expose FFmpeg and own one lazy host with shutdown cleanup', async () => {
  const configuration = loadPracticeRuntimeConfiguration(validEnv);
  assert.ok(configuration);
  const providers = createPracticeRuntimeProviders(configuration);
  const runtimeProvider = providers.find((provider) => provider.provide === PRACTICE_RUNTIME);
  const ffmpegProvider = providers.find((provider) => provider.provide === PRACTICE_FFMPEG_PATH);
  assert.ok(runtimeProvider);
  assert.ok(ffmpegProvider);
  assert.equal(ffmpegProvider.useValue, validEnv.LANGUAGE_PRACTICE_FFMPEG_PATH);

  const runtime = runtimeProvider.useFactory();
  assert.ok(runtime instanceof PracticeRuntimeHost);
  assert.equal(runtime.host, undefined);
  const host = runtime.getHost();
  assert.equal(runtime.getHost(), host);
  await runtime.onApplicationShutdown();
  assert.throws(() => runtime.getHost(), /stopped or closed/);
});

test('shutdown before first host use does not construct a host', async () => {
  const configuration = loadPracticeRuntimeConfiguration(validEnv);
  const runtime = new PracticeRuntimeHost(configuration);
  await runtime.onApplicationShutdown();
  assert.equal(runtime.host, undefined);
  assert.throws(() => runtime.getHost(), /stopped or closed/);
  assert.equal(runtime.host, undefined);
});
