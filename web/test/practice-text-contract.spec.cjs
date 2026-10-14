const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const { safeText, validateCreatePractice, parsePractice, parseCoverage } = require('../src/features/language-practice/practice-contract.ts');
const id = '123e4567-e89b-42d3-a456-426614174000';
const setup = { topic: 'travel', level: 'B1', durationMinutes: 5 };
const input = text => ({ title: text, setup: { level: setup.level, durationMinutes: setup.durationMinutes }, parameters: [{ requirement: text }] });
const practice = text => ({ ...input(text), setup, hasImage: false, id, teacherId: id, teacherName: 'Teacher', createdAt: '2026-01-01T00:00:00.000Z', parameters: [{ id, requirement: text }] });

test('creation is topic-free and practice image presence is an exact required boolean', () => {
  assert.doesNotThrow(() => validateCreatePractice(input('Ordering sushi')));
  assert.throws(() => validateCreatePractice({ ...input('Sushi'), setup }), { kind: 'invalid-input' });
  for (const hasImage of [true, false]) assert.equal(parsePractice({ ...practice('Sushi'), hasImage }).hasImage, hasImage);
  for (const hasImage of [undefined, null, 0, 'true']) assert.throws(() => parsePractice({ ...practice('Sushi'), hasImage }), { kind: 'invalid-response' });
  const { hasImage, ...missing } = practice('Sushi');
  assert.throws(() => parsePractice(missing), { kind: 'invalid-response' });
  assert.throws(() => parsePractice({ ...practice('Sushi'), imageUrl: 'https://example.test' }), { kind: 'invalid-response' });
});
test('catalogue difficulty preserves explicit values and normalizes only legacy omission to null', () => {
  const legacy = practice('Sushi');
  assert.equal(parsePractice(legacy).setup.difficulty, null);
  assert.equal(Object.hasOwn(legacy.setup, 'difficulty'), false, 'parsing must not mutate the input');
  for (const difficulty of [null, 'easy', 'medium', 'hard']) {
    const dto = { ...legacy, setup: { ...setup, difficulty } };
    assert.deepEqual(parsePractice(dto), dto);
  }
  for (const difficulty of [undefined, '', 'HARD', 'expert', 1, false, [], {}]) {
    assert.throws(() => parsePractice({ ...legacy, setup: { ...setup, difficulty } }), { kind: 'invalid-response' });
  }
  for (const override of [{ unrelated: true }, { level: 'Z9' }, { durationMinutes: 20 }]) {
    assert.throws(() => parsePractice({ ...legacy, setup: { ...setup, difficulty: 'easy', ...override } }), { kind: 'invalid-response' });
  }
});

test('new practice difficulty is optional but never nullable and preserves strict setup keys', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    assert.doesNotThrow(() => validateCreatePractice({ ...input('Sushi'), setup: { ...input('Sushi').setup, difficulty } }));
  }
  for (const difficulty of [null, undefined, '', 'expert', 1, false, [], {}]) {
    assert.throws(() => validateCreatePractice({ ...input('Sushi'), setup: { ...input('Sushi').setup, difficulty } }), { kind: 'invalid-input' });
  }
  for (const override of [{ unrelated: true }, { level: 'Z9' }, { durationMinutes: 20 }, { topic: 'travel' }]) {
    assert.throws(() => validateCreatePractice({ ...input('Sushi'), setup: { ...input('Sushi').setup, difficulty: 'hard', ...override } }), { kind: 'invalid-input' });
  }
});

const coverage = (overrides = {}) => ({ parameterId: id, requirement: 'Ask for directions', status: 'met', evidenceSequences: [1], explanation: 'The student asked for directions.', ...overrides });

test('teacher and coverage snapshot text preserves emoji, tabs and ordinary line breaks', () => {
  const text = 'Travel 😀\tplease\nAsk for directions\r\nThen reply\rThanks';
  assert.equal(safeText(text, 500), true);
  assert.doesNotThrow(() => validateCreatePractice(input(text)));
  assert.deepEqual(parsePractice(practice(text)), { ...practice(text), setup: { ...setup, difficulty: null } });
  const entry = coverage({ requirement: text, explanation: text });
  assert.deepEqual(parseCoverage([entry]), [entry]);
});

test('text rejects every disallowed C0 control, DEL and unpaired UTF-16 surrogate', () => {
  const invalid = [...Array.from({ length: 32 }, (_, n) => n).filter(n => ![9, 10, 13].includes(n)), 127]
    .map(n => `before${String.fromCharCode(n)}after`);
  invalid.push('\ud800', '\udfff', 'before\ud800after', 'before\udfffafter', '\ud800\ud800', '\udc00\ud800', '😀\ud800');
  for (const text of invalid) {
    assert.equal(safeText(text, 500), false, JSON.stringify(text));
    assert.throws(() => validateCreatePractice({ ...input('Valid'), title: text }), { kind: 'invalid-input' });
    assert.throws(() => validateCreatePractice({ ...input('Valid'), parameters: [{ requirement: text }] }), { kind: 'invalid-input' });
    assert.throws(() => parsePractice({ ...practice('Valid'), title: text }), { kind: 'invalid-response' });
    assert.throws(() => parsePractice({ ...practice('Valid'), parameters: [{ id, requirement: text }] }), { kind: 'invalid-response' });
    for (const field of ['requirement', 'explanation']) {
      assert.throws(() => parseCoverage([coverage({ [field]: text })]), { kind: 'invalid-response' });
    }
  }
});

test('text remains bounded and rejects empty or whitespace-only required fields', () => {
  for (const text of ['', ' \t\r\n ']) {
    assert.equal(safeText(text, 500), false);
    assert.throws(() => validateCreatePractice(input(text)), { kind: 'invalid-input' });
    assert.throws(() => parsePractice(practice(text)), { kind: 'invalid-response' });
    assert.throws(() => parseCoverage([coverage({ requirement: text })]), { kind: 'invalid-response' });
  }
  for (const maximum of [120, 500]) {
    assert.equal(safeText('x'.repeat(maximum), maximum), true);
    assert.equal(safeText('x'.repeat(maximum + 1), maximum), false);
  }
  assert.equal(safeText('😀', 2), true);
  assert.equal(safeText('😀', 1), false, 'bounds count UTF-16 code units without normalization');
});

for (const explanation of ['', ' \t\r\n ']) {
  test(`coverage rejects a non-content explanation ${JSON.stringify(explanation)}`, () => {
    assert.throws(() => parseCoverage([coverage({ explanation })]), { kind: 'invalid-response' });
  });
}
for (const status of ['met', 'partial']) {
  test(`coverage rejects ${status} without evidence`, () => {
    assert.throws(() => parseCoverage([coverage({ status, evidenceSequences: [] })]), { kind: 'invalid-response' });
  });
}
test('coverage rejects evidence for unassessed status', () => {
  assert.throws(() => parseCoverage([coverage({ status: 'unassessed' })]), { kind: 'invalid-response' });
});
test('coverage preserves alternate structural states and strict evidence and identifier validation', () => {
  for (const [status, evidenceSequences] of [['met', [257]], ['partial', [2]], ['not-met', []], ['not-met', [3]], ['unassessed', []]]) {
    const entry = coverage({ status, evidenceSequences });
    assert.deepEqual(parseCoverage([entry]), [entry], 'web structure validation does not prove student ownership or completion');
  }
  for (const overrides of [{ status: 'unknown' }, { evidenceSequences: [1, 1] }, { evidenceSequences: [0] }, { evidenceSequences: [1.5] }, { parameterId: 'invalid' }]) {
    assert.throws(() => parseCoverage([coverage(overrides)]), { kind: 'invalid-response' });
  }
  assert.throws(() => parseCoverage([coverage(), coverage()]), { kind: 'invalid-response' });
});
