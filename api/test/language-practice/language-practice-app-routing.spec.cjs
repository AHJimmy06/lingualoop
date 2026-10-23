const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestMethod } = require('@nestjs/common');
const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');

// Give AppModule a synthetic valid auth configuration while leaving all optional
// speech/coach runtime settings absent. No provider requests or database calls occur.
const authEnvironment = {
  GOOGLE_CALLBACK_URL: 'http://localhost:5001/auth/google/callback',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  LINGUALOOP_TOKEN_SIGNING_KEY: 'test-signing-key-that-is-long-enough-for-validation',
  LINGUALOOP_WEB_ORIGIN: 'http://localhost:5173',
};
const previousEnvironment = new Map();
for (const [key, value] of Object.entries(authEnvironment)) {
  previousEnvironment.set(key, process.env[key]);
  process.env[key] = value;
}
for (const key of [
  'LINGUALOOP_STT_PYTHON',
  'LINGUALOOP_FASTCONFORMER_MODEL_PATH',
  'LANGUAGE_PRACTICE_FFMPEG_PATH',
  'LINGUALOOP_FASTCONFORMER_MODEL_SHA256',
  'LANGUAGE_PRACTICE_PIPER_PATH',
  'LANGUAGE_PRACTICE_PIPER_MODEL_EN',
  'LANGUAGE_PRACTICE_PIPER_MODEL_ES',
  'LINGUALOOP_PIPER_MODEL_EN_SHA256',
  'LINGUALOOP_PIPER_MODEL_ES_SHA256',
  'LINGUALOOP_PIPER_SIDECAR_EN_SHA256',
  'LINGUALOOP_PIPER_SIDECAR_ES_SHA256',
]) {
  previousEnvironment.set(key, process.env[key]);
  delete process.env[key];
}
const { AppModule } = require('../../dist/app.module.js');
for (const [key, value] of previousEnvironment) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
const { LanguagePracticeSessionController } = require('../../dist/language-practice/language-practice-session.controller.js');
const { LanguagePracticeTurnController } = require('../../dist/language-practice/language-practice-turn.controller.js');
const { LANGUAGE_PRACTICE_REPORT_SERVICE } = require('../../dist/language-practice/language-practice-session.providers.js');

test('auth-only AppModule registers session creation without optional turn runtime', () => {
  const controllers = Reflect.getMetadata('controllers', AppModule);
  assert.ok(controllers.includes(LanguagePracticeSessionController));
  assert.ok(controllers.includes(LanguagePracticeTurnController), 'turn submission stays registered when speech/coach configuration is absent');
  const providers = Reflect.getMetadata('providers', AppModule);
  assert.ok(providers.some((provider) => provider && provider.provide === LANGUAGE_PRACTICE_REPORT_SERVICE),
    'the report service is registered even without optional provider configuration');

  const method = LanguagePracticeSessionController.prototype.createSession;
  assert.equal(typeof method, 'function');
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), 'sessions');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), RequestMethod.POST);
  assert.equal(Reflect.getMetadata(PATH_METADATA, LanguagePracticeSessionController), 'language-practice');
  const turns = LanguagePracticeSessionController.prototype.getSessionTurns;
  assert.equal(Reflect.getMetadata(PATH_METADATA, turns), 'sessions/:sessionId/turns');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, turns), RequestMethod.GET);
});
