const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LanguagePracticeReportAiAdapter,
  LanguagePracticeReportAiUnavailableError,
} = require('../../dist/language-practice/language-practice-report-ai.js');

const turns = [
  {
    sequence: 7,
    transcript: 'Ayer yo voy al parque.',
    spanishCorrectionEvidence: JSON.stringify({
      correctedPhrase: 'Ayer fui al parque.',
      feedback: "El verbo 'voy' cambia a 'fui' para expresar el pasado.",
    }),
  },
];
const output = {
  summary: 'La sesión incluyó una intervención sobre una visita al parque.',
  corrections: [{
    sequence: 7,
    original: 'Ayer yo voy al parque.',
    correctedPhrase: 'Ayer fui al parque.',
    explanation: "El verbo 'voy' cambia a 'fui' para expresar el pasado.",
  }],
  strengths: ['Compartió una experiencia personal en español.'],
  recommendations: ['Practique el uso del pasado en otras frases.'],
};
function fakeClient(response) {
  const calls = [];
  return { calls, client: { responses: { create: async (request) => { calls.push(request); return response; } } } };
}

test('sends bounded untrusted session evidence once with strict JSON schema and explicit model', async () => {
  const fake = fakeClient({ status: 'completed', output_text: JSON.stringify(output) });
  const adapter = new LanguagePracticeReportAiAdapter(fake.client, 'injected-model');
  assert.deepEqual(await adapter.generate(turns, { topic: 'parques', level: 'B1' }), output);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].model, 'injected-model');
  assert.equal(fake.calls[0].max_output_tokens, 3000);
  assert.equal(fake.calls[0].store, false);
  assert.equal(fake.calls[0].text.format.type, 'json_schema');
  assert.equal(fake.calls[0].text.format.strict, true);
  assert.equal(fake.calls[0].text.format.schema.additionalProperties, false);
  const schemaText = JSON.stringify(fake.calls[0].text.format.schema);
  assert.doesNotMatch(schemaText, /maxLength|maxItems|minLength/);
  assert.deepEqual(fake.calls[0].input.map(({ role }) => role), ['system', 'user']);
  assert.match(fake.calls[0].input[1].content, /UNTRUSTED_SESSION_DATA/);
  assert.match(fake.calls[0].input[1].content, /Ayer yo voy al parque/);
});

test('rejects invalid or unlinked report output with generic unavailable and no retry', async (t) => {
  const cases = [
    ['incomplete', { status: 'incomplete', output_text: JSON.stringify(output) }],
    ['missing status', { output_text: JSON.stringify(output) }],
    ['failed status', { status: 'failed', output_text: JSON.stringify(output) }],
    ['unpaired summary surrogate', { status: 'completed', output_text: JSON.stringify({ ...output, summary: String.fromCharCode(0xd800) }) }],
    ['too many strengths', { status: 'completed', output_text: JSON.stringify({ ...output, strengths: ['uno', 'dos', 'tres', 'cuatro'] }) }],
    ['too many recommendations', { status: 'completed', output_text: JSON.stringify({ ...output, recommendations: ['uno', 'dos', 'tres', 'cuatro'] }) }],
    ['refusal', { status: 'completed', output_text: '', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }],
    ['malformed or wrong keys', { status: 'completed', output_text: JSON.stringify({ ...output, surprise: true }) }],
    ['oversized', { status: 'completed', output_text: 'x'.repeat(10001) }],
    ['locally capped summary', { status: 'completed', output_text: JSON.stringify({ ...output, summary: 'x'.repeat(401) }) }],
    ['wrong sequence', { status: 'completed', output_text: JSON.stringify({ ...output, corrections: [{ ...output.corrections[0], sequence: 99 }] }) }],
    ['wrong original', { status: 'completed', output_text: JSON.stringify({ ...output, corrections: [{ ...output.corrections[0], original: 'invented' }] }) }],
    ['wrong correction', { status: 'completed', output_text: JSON.stringify({ ...output, corrections: [{ ...output.corrections[0], correctedPhrase: 'invented' }] }) }],
    ['unsupported explanation', { status: 'completed', output_text: JSON.stringify({ ...output, corrections: [{ ...output.corrections[0], explanation: 'Pronunciación perfecta.' }] }) }],
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    const fake = fakeClient(response);
    const adapter = new LanguagePracticeReportAiAdapter(fake.client, 'model');
    await assert.rejects(adapter.generate(turns), (error) => {
      assert.ok(error instanceof LanguagePracticeReportAiUnavailableError);
      assert.equal(error.message, 'The session report is temporarily unavailable');
      return true;
    });
    assert.equal(fake.calls.length, 1);
  });
});

test('bounds inputs before calling the client and never drops turns silently', async () => {
  const fake = fakeClient({ status: 'completed', output_text: JSON.stringify(output) });
  const adapter = new LanguagePracticeReportAiAdapter(fake.client, 'model');
  await assert.rejects(adapter.generate(Array.from({ length: 257 }, (_, sequence) => ({ ...turns[0], sequence }))));
  await assert.rejects(adapter.generate([{ ...turns[0], transcript: 'x'.repeat(5001) }]));
  await assert.rejects(adapter.generate([{ ...turns[0], spanishCorrectionEvidence: 'x'.repeat(2001) }]));
  await assert.rejects(adapter.generate(Array.from({ length: 21 }, (_, sequence) => ({
    sequence: sequence + 1, transcript: 'x'.repeat(4000), spanishCorrectionEvidence: null,
  }))));
  assert.equal(fake.calls.length, 0);
});

test('does not construct a provider client, read credentials, or configure a model', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/language-practice/language-practice-report-ai.ts'), 'utf8');
  assert.doesNotMatch(source, /new OpenAI|process\.env|API_KEY|fetch\s*\(|https?:\/\//i);
});
