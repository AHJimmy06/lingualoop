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

test('login exposes Google sign-in as a true semantic link', () => {
  const markup = renderToStaticMarkup(React.createElement(LoginView, { status: '', logout: '' }));
  const googleLink = markup.match(/<a\b[^>]*href="\/api\/auth\/google"[^>]*>/)?.[0];
  assert.ok(googleLink, 'Google sign-in should render as an anchor');
  assert.match(googleLink, /aria-label="Continue with Google"/);
  assert.doesNotMatch(googleLink, /\brole="button"/);
  assert.match(markup, /Continue with Google/);
});

test('Google sign-in anchor is not wrapped by the Base UI Button primitive', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/auth/LoginView.tsx'), 'utf8');
  assert.doesNotMatch(source, /import\s+\{\s*Button\s*\}\s+from\s+['"]\.\.\/\.\.\/components\/ui\/button['"]/);
  assert.doesNotMatch(source, /<Button\b/);
});

test('login explains unavailable refresh and unconfirmed logout without claiming success', () => {
  const unavailable = renderToStaticMarkup(React.createElement(LoginView, { status: 'unavailable', logout: '' }));
  const logout = renderToStaticMarkup(React.createElement(LoginView, { status: '', logout: 'unconfirmed' }));
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
