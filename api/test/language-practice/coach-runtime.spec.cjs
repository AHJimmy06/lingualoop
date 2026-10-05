const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ALLOWED_COACH_MODELS,
  CoachRuntimeConfigurationError,
  createOpenAICoachAdapter,
  createOpenAIResponsesClient,
  parseCoachKeyFile,
} = require('../../dist/language-practice/coach-runtime.providers.js');

const config = {
  keyFilePath: '/home/test/.local/share/lingualoop/coach.env',
  model: 'gpt-5.6-luna',
};
const contents = 'OPENAI_API_KEY=test-key-not-a-real-credential\n';

function dependencies(overrides = {}) {
  const observed = { constructorOptions: null, requestedPath: null };
  class FakeOpenAI {
    constructor(options) {
      observed.constructorOptions = options;
      this.responses = { create: async () => ({ status: 'completed', output_text: '' }) };
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

test('constructs a reusable Responses client with the allowlisted model and a no-retry 90-second SDK', () => {
  const deps = dependencies();
  const client = createOpenAIResponsesClient(config, deps);
  assert.equal(typeof client.responses.create, 'function');
  assert.equal(deps.observed.requestedPath, config.keyFilePath);
  assert.deepEqual(deps.observed.constructorOptions, {
    apiKey: 'test-key-not-a-real-credential', maxRetries: 0, timeout: 90_000,
  });
  assert.deepEqual(ALLOWED_COACH_MODELS, ['gpt-5.6-luna', 'gpt-6-luna']);
});

test('constructs the inert adapter with the allowlisted model and a no-retry 90-second SDK', () => {
  const deps = dependencies();
  const adapter = createOpenAICoachAdapter(config, deps);
  assert.equal(typeof adapter.respond, 'function');
  assert.equal(deps.observed.requestedPath, config.keyFilePath);
  assert.deepEqual(deps.observed.constructorOptions, {
    apiKey: 'test-key-not-a-real-credential', maxRetries: 0, timeout: 90_000,
  });
  assert.deepEqual(ALLOWED_COACH_MODELS, ['gpt-5.6-luna', 'gpt-6-luna']);
});

test('fails closed before reading when the key path is not absolute or the model is not allowlisted', () => {
  for (const invalid of [
    { ...config, keyFilePath: 'coach.env' },
    { ...config, model: 'other-model' },
    { keyFilePath: '', model: config.model },
    null,
  ]) {
    let read = false;
    assert.throws(
      () => createOpenAICoachAdapter(invalid, dependencies({ readFile: () => { read = true; return contents; } })),
      CoachRuntimeConfigurationError,
    );
    assert.equal(read, false);
  }
});

test('accepts only a strict single-key file and rejects whitespace, extra entries, and malformed lines', () => {
  assert.equal(parseCoachKeyFile(contents), 'test-key-not-a-real-credential');
  for (const invalid of [
    '',
    'OPENAI_API_KEY=\n',
    ' OPENAI_API_KEY=value\n',
    'OPENAI_API_KEY=value\nOTHER=value\n',
    'OPENAI_API_KEY=value\nOPENAI_API_KEY=again\n',
    'OPENAI_API_KEY= value\n',
    'OPENAI_API_KEY=value \n',
    'OPENAI_API_KEY=\u0000value\n',
    'OPENAI_API_KEY=\tvalue\n',
    'OPENAI_API_KEY=\u0001value\n',
    'OPENAI_API_KEY=value\u007f\n',
    'OPENAI_API_KEY=value\u0085\n',
    'OPENAI_API_KEY=value\u009f\n',
    'OPENAI_API_KEY=café\n',
    'OPENAI_API_KEY=value\n\n',
    '# comment\nOPENAI_API_KEY=value\n',
  ]) {
    assert.throws(() => parseCoachKeyFile(invalid), (error) => {
      assert.ok(error instanceof CoachRuntimeConfigurationError);
      assert.doesNotMatch(error.message, /value|again/i);
      return true;
    });
  }
});

test('refuses non-files and group/world-readable key files without constructing the SDK', () => {
  for (const mode of [0o100640, 0o100644]) {
    let constructed = false;
    const deps = dependencies({
      inspectFile: () => ({ isFile: () => true, mode }),
      OpenAIConstructor: class { constructor() { constructed = true; } },
    });
    assert.throws(() => createOpenAICoachAdapter(config, deps), CoachRuntimeConfigurationError);
    assert.equal(constructed, false);
  }
  assert.throws(() => createOpenAICoachAdapter(config, dependencies({
    inspectFile: () => ({ isFile: () => false, mode: 0o100600 }),
  })), CoachRuntimeConfigurationError);
});

test('SDK construction failures are replaced with a generic error and never disclose key material', () => {
  const deps = dependencies({
    OpenAIConstructor: class { constructor() { throw new Error(contents); } },
  });
  assert.throws(() => createOpenAICoachAdapter(config, deps), (error) => {
    assert.ok(error instanceof CoachRuntimeConfigurationError);
    assert.doesNotMatch(error.message, /test-key|OPENAI_API_KEY/i);
    return true;
  });
});
