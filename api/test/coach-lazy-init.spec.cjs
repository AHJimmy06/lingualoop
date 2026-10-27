const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createLanguagePracticeTurnProviders, LANGUAGE_PRACTICE_TURN_COACH } = require('../dist/language-practice/language-practice-turn.providers');

test('root environment API key supports GPT-6 Luna without reading a separate file', async () => {
  let constructed = 0;
  const providers = createLanguagePracticeTurnProviders({
    LINGUALOOP_OPENAI_COACH_ENABLED: 'true',
    OPENAI_API_KEY: 'test-key-not-real',
    LANGUAGE_PRACTICE_OPENAI_MODEL: 'gpt-6-luna',
  }, {
    OpenAIConstructor: class {
      constructor(options) {
        constructed++;
        assert.equal(options.apiKey, 'test-key-not-real');
        this.responses = { create: async input => { assert.equal(input.model, 'gpt-6-luna'); return {}; } };
      }
    },
    readFile() { assert.fail('direct environment key must not read a key file'); },
    inspectFile() { assert.fail('direct environment key must not inspect a key file'); },
  });
  const coach = providers.find(p => p.provide === LANGUAGE_PRACTICE_TURN_COACH).useValue;
  assert.equal(constructed, 0);
  await assert.rejects(coach.respond({
    context: { targetLanguage: { code: 'en', label: 'English' }, topic: { code: 'travel', label: 'Travel' }, source: 'practice-catalog' },
    level: 'A2', transcript: 'I visited a museum.', history: [],
  }));
  assert.equal(constructed, 1);
});

test('OpenAI coach remains disabled unless the explicit opt-in flag is true', () => {
  const providers = createLanguagePracticeTurnProviders({
    LINGUALOOP_OPENAI_API_KEY_FILE: path.join(process.env.LOCALAPPDATA || process.env.TEMP || '/tmp', 'LinguaLoop', 'secrets', 'coach.env'),
    LANGUAGE_PRACTICE_OPENAI_MODEL: 'gpt-5.6-luna',
    LINGUALOOP_OPENAI_COACH_ENABLED: 'false',
  });
  assert.deepEqual(providers, []);
});

test('OpenAI client and request are both deferred until an explicit coach response', async () => {
  let constructed = 0;
  let requests = 0;
  class FakeOpenAI {
    constructor() {
      constructed += 1;
      this.responses = { create: async () => { requests += 1; return {}; } };
    }
  }
  const keyFilePath = path.join(process.env.LOCALAPPDATA || '/synthetic', 'LinguaLoop', 'secrets', 'coach.env');
  const providers = createLanguagePracticeTurnProviders({
    LINGUALOOP_OPENAI_COACH_ENABLED: 'true',
    LINGUALOOP_OPENAI_API_KEY_FILE: keyFilePath,
    LANGUAGE_PRACTICE_OPENAI_MODEL: 'gpt-5.6-luna',
  }, {
    OpenAIConstructor: FakeOpenAI,
    inspectFile: () => ({ isFile: () => true, mode: 0o100600 }),
    readFile: () => 'OPENAI_API_KEY=test-key',
  });
  const provider = providers.find((item) => item.provide === LANGUAGE_PRACTICE_TURN_COACH);
  assert.ok(provider);
  assert.equal(constructed, 0);
  assert.equal(requests, 0);

  await assert.rejects(provider.useValue.respond({
    context: { targetLanguage: { code: 'en', label: 'English' }, topic: { code: 'travel', label: 'Travel' }, source: 'practice-catalog' },
    level: 'A2', transcript: 'I visited a museum.', history: [],
  }));
  assert.equal(constructed, 1);
  assert.equal(requests, 1);
});
