const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: filename }).outputText, filename);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(__dirname, '../src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};
const { PracticeReportContent } = require('../src/features/language-practice/PracticeReportContent.tsx');
const report = {
  sessionId: 'session', summary: 'Resumen histórico.', corrections: [{ sequence: 1, original: 'I go yesterday.', correctedPhrase: 'Fui ayer.', explanation: 'Se usa pasado.' }],
  strengths: ['Comunica una experiencia.'], recommendations: ['Practica el pasado.'], generatedWithAi: true, parameterCoverage: [], createdAt: '2026-10-21T00:00:00Z',
};
const session = { id: 'session', topic: 'travel', level: 'A1', turns: [{ sequence: 1, transcript: 'I go yesterday.', assistantResponse: 'Where did you go?' }] };
const learningSupport = {
  corrections: [{ sequence: 1, suggestedEnglish: 'I went yesterday. <script>unsafe</script>', translationEs: 'Fui ayer.', explanationEn: 'Use the past tense.', explanationEs: 'Usa el tiempo pasado.' }],
  strengths: [{ textEn: 'You described an experience.', textEs: 'Describiste una experiencia.', evidenceSequences: [1] }],
  recommendations: [{ textEn: 'Practise the past tense.', textEs: 'Practica el pasado.', evidenceSequences: [1] }],
};
const render = props => renderToStaticMarkup(React.createElement(PracticeReportContent, { report, session, ...props }));

test('English support renders suggested wording with audio and evidence-linked annotations in tables', () => {
  const html = render({ learningSupport });
  assert.match(html, /Suggested wording \(English\)/);
  assert.match(html, /I went yesterday\. &lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Listen to suggestion for turn 1/);
  assert.match(html, /title="Listen to suggestion for turn 1"/);
  assert.match(html, /aria-label="Listen to suggestion for turn 1"/);
  assert.doesNotMatch(html, />Listen to suggestion for turn 1</);
  assert.doesNotMatch(html, /title="Explain in Spanish"/);
  assert.doesNotMatch(html, />Explain in Spanish</);
  assert.match(html, /Use the past tense\./);
  assert.match(html, /You described an experience\./);
  assert.match(html, /Practise the past tense\./);
  assert.match(html, /English annotation/);
  assert.match(html, />Turn<\/th><th[^>]*>Español<\/th>/);
  assert.doesNotMatch(html, /title="Ver traducción al español: Observed strengths, 1"/);
  assert.match(html, /title="Escuchar traducción al español: Observed strengths, 1"/);
  assert.doesNotMatch(html, /title="Ver traducción al español: Next practice, 1"/);
  assert.match(html, /title="Escuchar traducción al español: Next practice, 1"/);
  assert.match(html, /class="flex items-start gap-2"/);
  assert.match(html, /href="#turn-1"/);
  assert.doesNotMatch(html, /Explain in Spanish/);
  assert.match(html, /Traducción y explicación/);
  assert.doesNotMatch(html, /Saved wording · Español|Prepare English version/);
});

test('legacy Spanish wording is explicitly labeled and cannot masquerade as an English suggestion', () => {
  const html = render({ onLoadSupport() {} });
  assert.match(html, /Prepare English version/);
  assert.match(html, /Saved wording · Español/);
  assert.match(html, /Saved explanation · Español/);
  assert.match(html, /Saved notes · Español/);
  assert.match(html, /Prepare the English version to see a suggested phrase/);
  assert.doesNotMatch(html, /Listen to suggestion/);
});

test('support preparation is explicit and preserves legacy content on loading and failure', () => {
  const html = render({ supportLoading: true, supportError: 'The service is unavailable.', onLoadSupport() {} });
  assert.match(html, /Preparing English version/);
  assert.match(html, /disabled/);
  assert.match(html, /The service is unavailable/);
  assert.match(html, /Fui ayer\./);
  const dialog = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/ReportSpanishExplanation.tsx'), 'utf8');
  assert.match(dialog, /Dialog\.Title/);
  assert.match(dialog, /Dialog\.Close/);
  assert.match(dialog, /lang="es"/);
  assert.match(dialog, /ReportSpeechButton text=\{text\} language="es"/);
  assert.doesNotMatch(dialog, /fetch\(|authSession|dangerouslySetInnerHTML/);
});
