const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CoachAdapter, CoachAdapterUnavailableError, getCoachDiagnostic } = require('../../dist/language-practice/coach-adapter.js');

const input = {
  context: {
    targetLanguage: { code: 'en', label: 'English' },
    topic: { code: 'cafe', label: 'Ordering at a café' },
    source: 'practice-catalog',
  },
  level: 'A2',
  transcript: 'Ayer yo voy al parque.',
  history: [{ role: 'assistant', content: 'What did you do yesterday?' }],
};
const goodOutput = JSON.stringify({
  correctedPhrase: 'Ayer fui al parque.',
  feedback: "El verbo 'voy' cambia a 'fui' para expresar el pasado.",
  assistantResponse: 'That sounds like a lovely afternoon. The park must have been peaceful. Did you see anything interesting there?',
});

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    client: { responses: { create: async (request) => { calls.push(request); return response; } } },
  };
}

test('sends the original strict Responses API request once and returns only the parsed fields', async () => {
  const fake = fakeClient({ status: 'completed', output_text: goodOutput });
  const adapter = new CoachAdapter(fake.client, 'injected-model');
  const result = await adapter.respond(input);
  assert.deepEqual(result, JSON.parse(goodOutput));
  assert.equal(fake.calls.length, 1);
  const request = fake.calls[0];
  assert.equal(request.model, 'injected-model');
  assert.equal(request.store, false);
  assert.equal(request.reasoning.effort, 'none');
  assert.equal(request.max_output_tokens, 1200);
  assert.deepEqual(request.text.format, {
    type: 'json_schema', name: 'language_practice_coaching', strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        correctedPhrase: { type: 'string', minLength: 1, maxLength: 300, description: request.text.format.schema.properties.correctedPhrase.description },
        feedback: { type: 'string', minLength: 1, maxLength: 280, description: request.text.format.schema.properties.feedback.description },
        assistantResponse: { type: 'string', minLength: 1, maxLength: 500, description: request.text.format.schema.properties.assistantResponse.description },
      },
      required: ['correctedPhrase', 'feedback', 'assistantResponse'],
    },
  });
  assert.deepEqual(request.input.map(({ role }) => role), ['system', 'user']);
  assert.match(request.input[1].content, /conversationHistory/);
});

test('refusal, incomplete, malformed, oversized and provider failures are generic and never retried', async (t) => {
  const cases = [
    { name: 'refusal', response: { status: 'completed', output_text: '', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'sensitive provider text' }] }] } },
    { name: 'incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'private output' } },
    { name: 'invalid JSON', response: { status: 'completed', output_text: '{"secret":"do not leak"}' } },
    { name: 'oversized content', response: { status: 'completed', output_text: 'x'.repeat(1601) } },
    { name: 'provider error', response: new Error('private key or provider details') },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fake = fakeClient(scenario.response);
      const adapter = new CoachAdapter(fake.client, 'model');
      await assert.rejects(adapter.respond(input), (error) => {
        assert.ok(error instanceof CoachAdapterUnavailableError);
        assert.equal(error.message, 'The conversation coach is temporarily unavailable');
        assert.doesNotMatch(error.message, /private|secret|output|key/i);
        return true;
      });
      assert.equal(fake.calls.length, 1);
    });
  }
});

test('does not construct a provider client, read credentials, or configure a model', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/language-practice/coach-adapter.ts'), 'utf8');
  assert.doesNotMatch(source, /new OpenAI|process\.env|API_KEY|fetch\s*\(|https?:\/\//i);
});

test('safe diagnostic distinguishes validation from provider failure without exposing response or credentials', async () => {
  const invalid = new CoachAdapter(fakeClient({ status: 'completed', output_text: '{}' }).client, 'model');
  await assert.rejects(invalid.respond(input), error => {
    assert.deepEqual(getCoachDiagnostic(error), { code: 'output_validation', component: 'coach', phase: 'request' });
    return true;
  });
  const provider = new CoachAdapter({ responses: { create: async () => { throw new Error('private provider text'); } } }, 'model');
  await assert.rejects(provider.respond(input), error => {
    assert.deepEqual(getCoachDiagnostic(error), { code: 'provider_error', component: 'coach', phase: 'request' });
    assert.doesNotMatch(JSON.stringify(getCoachDiagnostic(error)), /private/);
    return true;
  });
});
