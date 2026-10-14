const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePracticeInput, parsePracticeParameters } = require('../../dist/language-practice/practice-catalogue.js');
const { validateParameterCoverage } = require('../../dist/language-practice/parameter-coverage.js');

const id = '123e4567-e89b-42d3-a456-426614174000';
const setup = { level: 'B1', durationMinutes: 5 };
const parameters = [{ id, requirement: 'Explain your destination' }];
const coverage = { parameterId: id, requirement: parameters[0].requirement, status: 'met', evidenceSequences: [1], explanation: 'Student described a destination.' };
const fields = {
  title(value) {
    return validatePracticeInput({ title: value, setup, parameters: [{ requirement: parameters[0].requirement }] }).title;
  },
  requirement(value) {
    return validatePracticeInput({ title: 'Travel', setup, parameters: [{ requirement: value }] }).parameters[0].requirement;
  },
  snapshot(value) {
    return parsePracticeParameters([{ id, requirement: value }])[0].requirement;
  },
  explanation(value) {
    return validateParameterCoverage([{ ...coverage, explanation: value }], parameters, new Set([1]))[0].explanation;
  },
};
const forbiddenControls = Array.from({ length: 33 }, (_, code) => code === 32 ? 127 : code)
  .filter(code => ![9, 10, 13].includes(code)).map(code => String.fromCharCode(code));

for (const [field, validate] of Object.entries(fields)) {
  for (const [name, control] of [['NUL', '\u0000'], ['vertical tab', '\u000b'], ['escape', '\u001b'], ['DEL', '\u007f']]) {
    test(`${field} rejects ${name}`, () => {
      assert.throws(() => validate(`Text${control}text`), TypeError);
    });
  }
  test(`${field} rejects every other C0 control and unpaired UTF-16 surrogate`, () => {
    for (const invalid of [...forbiddenControls, '\ud800', '\udbff', '\udc00', '\udfff', '\ud800x\udc00', '\udc00\ud800']) {
      assert.throws(() => validate(`Text${invalid}text`), TypeError, JSON.stringify(invalid));
    }
  });
  test(`${field} preserves multiline, HT/LF/CR whitespace and valid Unicode exactly`, () => {
    for (const valid of [' First\tline\nSecond\r\nThird\rline ', 'Viaje a España 😀 🚀', '<b>Teacher & student</b>', 'x']) {
      assert.equal(validate(valid), valid);
    }
    const max = field === 'title' ? 120 : 500;
    assert.equal(validate('x'.repeat(max)), 'x'.repeat(max));
    for (const invalid of ['', ' \t\n\r ', 'x'.repeat(max + 1), null, 123]) {
      assert.throws(() => validate(invalid), TypeError);
    }
  });
}

test('coverage retains exact multiline snapshot identity and student sequence grounding', () => {
  const snapshot = [{ id, requirement: ' Explain\twhere\nyou want\r\nto go 😀 ' }];
  const row = { ...coverage, requirement: snapshot[0].requirement, explanation: 'Destination\nexplained\tby student.\r\n😀' };
  assert.deepEqual(validateParameterCoverage([row], snapshot, new Set([1])), [row]);
  assert.throws(() => validateParameterCoverage([{ ...row, requirement: row.requirement.trim() }], snapshot, new Set([1])), TypeError);
  assert.throws(() => validateParameterCoverage([{ ...row, evidenceSequences: [2] }], snapshot, new Set([1])), TypeError);
  assert.throws(() => validateParameterCoverage([{ ...row, evidenceSequences: [] }], snapshot, new Set([1])), TypeError);
});
