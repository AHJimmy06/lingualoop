const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { resolveRoute } = require('../src/react-route-policy.ts');

test('redirects unauthenticated root and unknown paths to login', () => {
  assert.deepEqual(resolveRoute('/', '', 'no-session'), { kind: 'redirect', to: '/login' });
  assert.deepEqual(resolveRoute('/missing', '', 'no-session'), { kind: 'redirect', to: '/login' });
});

test('protects setup, live, and completion routes and distinguishes refresh outage', () => {
  for (const path of ['/language-practice', '/language-practice/sessions/abc', '/language-practice/sessions/abc/complete']) {
    assert.deepEqual(resolveRoute(path, '', 'no-session'), { kind: 'redirect', to: '/login' });
    assert.deepEqual(resolveRoute(path, '', 'unavailable'), { kind: 'redirect', to: '/login?status=unavailable' });
    assert.deepEqual(resolveRoute(path, '', 'authenticated', 'student'), { kind: 'render' });
  }
});

test('redirects authenticated login visits except an explicit unconfirmed logout', () => {
  assert.deepEqual(resolveRoute('/login', '', 'authenticated', 'student'), { kind: 'redirect', to: '/language-practice' });
  assert.deepEqual(resolveRoute('/login', '?logout=unconfirmed', 'authenticated', 'student'), { kind: 'render' });
  assert.deepEqual(resolveRoute('/login', '?status=unavailable', 'unavailable'), { kind: 'render' });
});

test('keeps the required route patterns and pending destinations represented', () => {
  const source = fs.readFileSync(require.resolve('../src/react-routes.tsx'), 'utf8');
  assert.match(source, /path="\/language-practice\/sessions\/:sessionId"/);
  assert.match(source, /path="\/language-practice\/sessions\/:sessionId\/complete"/);
  assert.match(source, /<RouteGate><LivePracticeView \/><\/RouteGate>/);
});
