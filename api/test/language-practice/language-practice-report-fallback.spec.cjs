const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLanguagePracticeReportFallback } = require('../../dist/language-practice/language-practice-report-fallback.js');

function turn(sequence, transcript = `utterance ${sequence}`, evidence = null) {
  return { sequence, transcript, spanishCorrectionEvidence: evidence };
}

function evidence(correctedPhrase = 'I am ready.', feedback = 'Use the present form.') {
  return JSON.stringify({ correctedPhrase, feedback });
}

test('zero turns uses the original empty-session fallback and no unsupported fields', () => {
  assert.deepEqual(buildLanguagePracticeReportFallback([]), {
    summary: 'The session ended without completed responses. There is not enough evidence to assess performance.',
    corrections: [],
    strengths: [],
    recommendations: [
      'Start a new practice and complete at least one response to receive evidence-based feedback.',
    ],
  });
});

test('one completed turn preserves exact corrections with neutral count evidence', () => {
  assert.deepEqual(buildLanguagePracticeReportFallback([
    turn(7, '  I ready.  ', evidence('  I am ready.  ', '  Use the present form.  ')),
  ]), {
    summary: 'Completed responses: 1. Evidence-linked corrections: 1.',
    corrections: [{
      sequence: 7,
      original: 'I ready.',
      correctedPhrase: 'I am ready.',
      explanation: 'Use the present form.',
    }],
    strengths: [],
    recommendations: [
      'Practise the corrected phrases using your own examples before your next session.',
    ],
  });
});

test('many turns produce a bounded English summary and exact evidence-backed counts', () => {
  const report = buildLanguagePracticeReportFallback([
    turn(1, 'She go yesterday.', evidence('She went yesterday.', 'Use past tense.')),
    turn(2, 'They is here.', evidence('They are here.', 'Match the plural subject.')),
    turn(3),
  ]);
  assert.equal(report.summary, 'Completed responses: 3. Evidence-linked corrections: 2.');
  assert.equal(report.corrections.length, 2);
  assert.equal(report.strengths.length, 0);
  assert.equal(report.recommendations.length, 1);
  assert.ok(report.summary.length <= 400);
});

test('malformed, missing, wrong-shaped, and empty evidence is omitted without inferred corrections', () => {
  const report = buildLanguagePracticeReportFallback([
    turn(1, 'I goed home.', '{not json'),
    turn(2, 'I am fine.', null),
    turn(3, 'I am fine.', JSON.stringify({ correctedPhrase: 'I am fine.' })),
    turn(4, 'I am fine.', JSON.stringify({ correctedPhrase: ' ', feedback: 'A note.' })),
    turn(5, 'I am fine.', JSON.stringify({ correctedPhrase: 'A phrase.', feedback: '' })),
    turn(6, ' ', evidence()),
  ]);
  assert.equal(report.corrections.length, 0);
  assert.equal(report.summary, 'Completed responses: 6. Evidence-linked corrections: 0.');
  assert.deepEqual(report.recommendations, [
    'Try another session on this topic and develop your ideas with examples.',
  ]);
  assert.doesNotMatch(JSON.stringify(report), /pronunciación|CEFR|A1|B2|fluidez nivel/i);
});

test('oversized evidence fields and transcript are clipped to their individual limits', () => {
  const report = buildLanguagePracticeReportFallback([
    turn(9, `  ${'o'.repeat(510)}  `, evidence(`  ${'c'.repeat(310)}  `, `  ${'e'.repeat(290)}  `)),
  ]);
  assert.deepEqual(report.corrections[0], {
    sequence: 9,
    original: 'o'.repeat(500),
    correctedPhrase: 'c'.repeat(300),
    explanation: 'e'.repeat(280),
  });
});

test('the report caps corrections at twenty and completed turns at 256', () => {
  const corrections = Array.from({ length: 25 }, (_, index) =>
    turn(index + 1, `original ${index + 1}`, evidence(`corrected ${index + 1}`, 'supported feedback')),
  );
  const report = buildLanguagePracticeReportFallback(corrections);
  assert.equal(report.corrections.length, 20);
  assert.equal(report.corrections[19].sequence, 20);
  assert.match(report.summary, /^Completed responses: 25\./);

  const bounded = buildLanguagePracticeReportFallback(Array.from({ length: 300 }, (_, index) => turn(index + 1)));
  assert.match(bounded.summary, /^Completed responses: 256\./);
  assert.equal(bounded.strengths.length, 0);
  assert.equal(bounded.recommendations.length, 1);
});
