const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRACTICE_FFMPEG_PATH,
  PRACTICE_RUNTIME,
  PracticeRuntimeHost,
  createPracticeRuntimeProviders,
  loadPracticeRuntimeConfiguration,
} = require('../../dist/language-practice/practice-runtime.providers.js');

const validEnv = {
  LINGUALOOP_STT_PYTHON: '/opt/lingualoop/venv/bin/python',
  LINGUALOOP_FASTCONFORMER_MODEL_PATH: '/opt/lingualoop/models/fastconformer.nemo',
  LINGUALOOP_FASTCONFORMER_MODEL_SHA256: 'a'.repeat(64),
  LANGUAGE_PRACTICE_FFMPEG_PATH: '/usr/bin/ffmpeg',
};

test('practice runtime accepts only complete, exact absolute paths and a SHA-256 digest', () => {
  const configuration = loadPracticeRuntimeConfiguration(validEnv);
  assert.ok(configuration);
  assert.equal(configuration.pythonExecutable, validEnv.LINGUALOOP_STT_PYTHON);
  assert.equal(configuration.modelPath, validEnv.LINGUALOOP_FASTCONFORMER_MODEL_PATH);
  assert.equal(configuration.ffmpegExecutable, validEnv.LANGUAGE_PRACTICE_FFMPEG_PATH);
  assert.match(configuration.workerPath, /scripts\/fastconformer-worker\.py$/);

  for (const env of [
    {},
    { ...validEnv, LINGUALOOP_STT_PYTHON: 'python' },
    { ...validEnv, LINGUALOOP_STT_PYTHON: '/opt/../python' },
    { ...validEnv, LINGUALOOP_STT_PYTHON: '/opt/python\0hidden' },
    { ...validEnv, LINGUALOOP_FASTCONFORMER_MODEL_SHA256: 'A'.repeat(64) },
    { ...validEnv, LINGUALOOP_FASTCONFORMER_MODEL_SHA256: 'a'.repeat(63) },
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
  assert.equal(host.config.startupTimeoutMs, 60000);
  assert.equal(host.config.requestTimeoutMs, undefined);
  let shutdownCalls = 0;
  host.shutdown = async () => { shutdownCalls++; };
  await runtime.onApplicationShutdown();
  assert.equal(shutdownCalls, 1);
});

test('shutdown before first host use does not construct a host', async () => {
  const configuration = loadPracticeRuntimeConfiguration(validEnv);
  const runtime = new PracticeRuntimeHost(configuration);
  await runtime.onApplicationShutdown();
  assert.equal(runtime.host, undefined);
  assert.throws(() => runtime.getHost(), /stopped or closed/);
  assert.equal(runtime.host, undefined);
});
