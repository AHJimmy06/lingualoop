const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const ts = require('typescript');

for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: filename,
    }).outputText;
    module._compile(output, filename);
  };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(__dirname, '../src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};

const { LoginView } = require('../src/features/auth/LoginView.tsx');
const { LanguagePracticeSetupView, isPracticeSetupValid } = require('../src/features/language-practice/LanguagePracticeSetupView.tsx');

test('role screens present bounded account and teacher forms without forbidden navigation', () => {
  const { AdminAccountsView } = require('../src/features/admin/AdminAccountsView.tsx');
  const { TeacherPracticesView } = require('../src/features/teacher/TeacherPracticesView.tsx');
  const wrap = view => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(view)));
  const admin = wrap(AdminAccountsView);
  assert.match(admin, /Accounts list/);
  assert.doesNotMatch(admin, /type="password"|>Name</);
  assert.match(admin, /maxLength="254"/i);
  assert.match(admin, /Google or Microsoft/);
  assert.match(admin, /type="email"/);
  assert.match(admin, /value="teacher"/);
  assert.match(admin, /value="student"/);
  assert.doesNotMatch(admin, /value="admin"|href="\/language-practice"|href="\/teacher"/);
  const teacher = wrap(TeacherPracticesView);
  assert.match(teacher, /Your practices/);
  assert.match(teacher, /maxLength="120"/i);
  assert.match(teacher, /maxLength="500"/i);
  assert.match(teacher, /Add requirement/);
  assert.doesNotMatch(teacher, /href="\/admin"|href="\/language-practice"/);
});
test('student catalogue renders all supplied teachers and read-only custom setup', () => {
  const { PracticeCards, PracticeDetails } = require('../src/features/language-practice/PracticeCatalogue.tsx');
  const base = { id: 'one', title: '<script>travel</script>', teacherId: 'teacher-one', teacherName: 'First Teacher', setup: { level: 'B1', topic: 'travel', durationMinutes: 5 }, parameters: [{ id: 'parameter', requirement: 'Ask for directions' }] };
  const cards = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(PracticeCards, { practices: [base, { ...base, id: 'two', title: 'Second teacher', teacherId: 'teacher-two' }] })));
  assert.match(cards, /Second teacher/);
  assert.match(cards, /&lt;script&gt;/);
  assert.match(cards, /<button/);
  assert.match(cards, /First Teacher/);
  assert.match(cards, /Practice goals/);
  assert.match(cards, /Ask for directions/);
  assert.match(cards, /\/images\/scenes\/travel-scene.webp/);
  assert.equal((cards.match(/<button/g) || []).length, 2, 'practice cards should be emitted for the shared parent grid');
  const details = renderToStaticMarkup(React.createElement(PracticeDetails, { practice: base }));
  assert.match(details, /Ask for directions/);
  assert.match(details, /B1/);
  assert.doesNotMatch(details, /<select|<input|<textarea/);
});
test('report coverage distinguishes unassessed from failure and escapes explanations', () => {
  const { ParameterCoverageView } = require('../src/features/language-practice/ParameterCoverageView.tsx');
  const coverage = ['met', 'partial', 'not-met', 'unassessed'].map(status => ({ parameterId: status, status, requirement: 'Directions', evidenceSequences: status === 'unassessed' ? [] : [1], explanation: '<script>evidence</script>' }));
  const html = renderToStaticMarkup(React.createElement(ParameterCoverageView, { coverage }));
  for (const text of ['Met', 'Partially met', 'Not met', 'Not assessed', 'not a failed requirement', 'Turn references', '&lt;script&gt;']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script>/);
});
const loginMarkup = props => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(LoginView, props)));
test('login uses OAuth-only registration without password fields', () => {
  const markup = loginMarkup({ status: '', logout: '' });
  assert.doesNotMatch(markup, /<form|type="email"|type="password"|href="\/signup"/);
  assert.match(markup, /first sign-in creates your account/i);
  assert.match(markup, /Checking sign-in options/);
});

test('login uses configured provider navigation without browser credential persistence', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/auth/LoginView.tsx'), 'utf8');
  assert.match(source, /fetch\('\/api\/auth\/providers'/);
  assert.ok(source.includes('window.location.assign(`/api/auth/${provider}`)'));
  assert.match(source, /setBusy\(true\)/);
  assert.doesNotMatch(source, /authSession\.login|localStorage|sessionStorage|type="password"/);
});

test('login explains unavailable refresh and unconfirmed logout without claiming success', () => {
  const unavailable = loginMarkup({ status: 'unavailable', logout: '' });
  const logout = loginMarkup({ status: '', logout: 'unconfirmed' });
  assert.match(unavailable, /could not check your session/i);
  assert.match(logout, /server did not confirm sign-out/i);
});

test('setup accepts only values from the validated service catalog', () => {
  const options = {
    levels: ['A1', 'A2'],
    topics: [{ code: 'travel', label: 'Travel' }],
    durationsMinutes: [5, 10],
  };
  assert.equal(isPracticeSetupValid(options, 'A1', 'travel', 5), true);
  assert.equal(isPracticeSetupValid(options, 'C2', 'travel', 5), false);
  assert.equal(isPracticeSetupValid(options, 'A1', 'unknown', 5), false);
  assert.equal(isPracticeSetupValid(options, 'A1', 'travel', 20), false);
  assert.equal(isPracticeSetupValid(null, 'A1', 'travel', 5), false);
});

test('setup initially shows honest option-loading status and does not auto-create a session', () => {
  const markup = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(LanguagePracticeSetupView)));
  assert.match(markup, /Loading available practice options/);
  assert.match(markup, /role="status"/);
  assert.doesNotMatch(markup, /Start practice|Starting practice/);
});
