const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createLanguagePracticeReportAiAdapter,
} = require('../../dist/language-practice/language-practice-report.providers.js');
const { LanguagePracticeReportAiAdapter } = require('../../dist/language-practice/language-practice-report-ai.js');

const env = {
  LINGUALOOP_OPENAI_COACH_ENABLED: 'true',
  LINGUALOOP_OPENAI_API_KEY_FILE: '/home/test/.local/share/lingualoop/coach.env',
  LANGUAGE_PRACTICE_OPENAI_MODEL: 'gpt-5.6-luna',
};
const contents = 'OPENAI_API_KEY=test-key-not-a-real-credential\n';

function dependencies(overrides = {}) {
  const observed = { constructorOptions: null, createCalls: 0, requestedPath: null };
  class FakeOpenAI {
    constructor(options) {
      observed.constructorOptions = options;
      this.responses = { create: async () => { observed.createCalls += 1; } };
    }
  }
  return {
    observed,
    OpenAIConstructor: FakeOpenAI,
    inspectFile: (filePath) => {
      observed.requestedPath = filePath;
      return { isFile: () => true, mode: 0o100600 };
    },
    readFile: (filePath) => {
      observed.requestedPath = filePath;
      return contents;
    },
    ...overrides,
  };
}

test('constructs an inert report adapter using the shared key-file policy and SDK options', () => {
  const deps = dependencies();
  const adapter = createLanguagePracticeReportAiAdapter(env, deps);
  assert.ok(adapter instanceof LanguagePracticeReportAiAdapter);
  assert.equal(deps.observed.requestedPath, env.LINGUALOOP_OPENAI_API_KEY_FILE);
  assert.deepEqual(deps.observed.constructorOptions, {
    apiKey: 'test-key-not-a-real-credential', maxRetries: 0, timeout: 90_000,
  });
  assert.equal(deps.observed.createCalls, 0);
});

test('returns undefined for missing or invalid configuration without reading or constructing', () => {
  for (const invalidEnv of [
    {},
    { ...env, LINGUALOOP_OPENAI_API_KEY_FILE: 'relative.env' },
    { ...env, LANGUAGE_PRACTICE_OPENAI_MODEL: 'unlisted-model' },
  ]) {
    let read = false;
    let constructed = false;
    const adapter = createLanguagePracticeReportAiAdapter(invalidEnv, dependencies({
      readFile: () => { read = true; return contents; },
      OpenAIConstructor: class { constructor() { constructed = true; } },
    }));
    assert.equal(adapter, undefined);
    assert.equal(read, false);
    assert.equal(constructed, false);
  }
});

test('returns undefined for unsafe or malformed key files without leaking key material', () => {
  for (const options of [
    { inspectFile: () => ({ isFile: () => true, mode: 0o100644 }) },
    { inspectFile: () => ({ isFile: () => false, mode: 0o100600 }) },
    { readFile: () => 'OPENAI_API_KEY=\n' },
    { readFile: () => `${contents}OTHER=value\n` },
  ]) {
    let constructed = false;
    const adapter = createLanguagePracticeReportAiAdapter(env, dependencies({
      ...options,
      OpenAIConstructor: class { constructor() { constructed = true; throw new Error(contents); } },
    }));
    assert.equal(adapter, undefined);
    assert.equal(constructed, false);
  }
  const deps = dependencies({
    OpenAIConstructor: class { constructor() { throw new Error(contents); } },
  });
  assert.equal(createLanguagePracticeReportAiAdapter(env, deps), undefined);
  assert.equal(deps.observed.createCalls, 0);
});
