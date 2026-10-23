const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: filename,
}).outputText, filename);
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  return resolve.call(this, request.startsWith('@/') ? path.join(__dirname, '../src', request.slice(2)) : request, parent, isMain, options);
};
const navigate = [];
let routeParams = {};
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'react-router-dom') return { useNavigate: () => destination => navigate.push(destination), Link: props => React.createElement('a', { href: props.to }, props.children), useParams: () => routeParams };
  return load.call(this, request, parent, isMain);
};
const { authSession } = require('../src/auth-session.ts');
const { LanguagePracticeClient } = require('../src/features/language-practice/language-practice-client.ts');
const optionModule = require('../src/features/language-practice/practice-options.ts');
const { LanguagePracticeSetupView, DefaultTopicTiles } = require('../src/features/language-practice/LanguagePracticeSetupView.tsx');
const { PracticeSettingsDialog } = require('../src/features/language-practice/PracticeSettingsDialog.tsx');
const { PracticeCards, PracticeCatalogue, CustomPracticeView } = require('../src/features/language-practice/PracticeCatalogue.tsx');
const { SubmissionsTable } = require('../src/features/teacher/TeacherResultsView.tsx');
const { TeacherPracticesDialog } = require('../src/features/teacher/TeacherPracticesDialog.tsx');
const { TeacherResultsClient } = require('../src/features/teacher/teacher-results-client.ts');
const { TeacherPracticesView } = require('../src/features/teacher/TeacherPracticesView.tsx');
const { PracticeCardPreview } = require('../src/features/language-practice/PracticeCardPreview.tsx');
const { PracticeReportContent } = require('../src/features/language-practice/PracticeReportContent.tsx');
const id = '123e4567-e89b-42d3-a456-426614174000';
const date = '2026-01-01T00:00:00.000Z';
const options = { levels: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], durationsMinutes: [5, 10, 15], topics: ['travel', 'work', 'studies', 'everyday-conversation'].map(code => ({ code, label: code })) };
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)];
}
function text(tree) { return React.Children.toArray(tree?.props?.children).map(child => typeof child === 'object' ? text(child) : child).join(' '); }
function find(tree, predicate) { const node = nodes(tree).find(predicate); assert.ok(node, 'expected rendered control'); return node; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(view) {
  const originals = Object.fromEntries(['useState', 'useMemo', 'useRef', 'useEffect'].map(key => [key, React[key]]));
  const state = []; const effects = []; const cleanups = [];
  let cursor = 0; let first = true; let mounted = true; let lateUpdates = 0;
  const hooks = {
    useState(initial) {
      const at = cursor++;
      if (!(at in state)) state[at] = typeof initial === 'function' ? initial() : initial;
      return [state[at], value => {
        if (!mounted) { lateUpdates++; return; }
        state[at] = typeof value === 'function' ? value(state[at]) : value;
      }];
    },
    useRef(initial) { const at = cursor++; if (!(at in state)) state[at] = { current: initial }; return state[at]; },
    useMemo(factory) { const at = cursor++; if (!(at in state)) state[at] = factory(); return state[at]; },
    useEffect(callback) { if (first) effects.push(callback); },
  };
  return {
    render() { Object.assign(React, hooks); cursor = 0; const tree = view(); first = false; return tree; },
    async effects() {
      effects.splice(0).forEach(callback => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); });
      await new Promise(done => setImmediate(done));
    },
    restartEffects() { cleanups.splice(0).forEach(cleanup => cleanup()); first = true; },
    unmount() { cleanups.splice(0).forEach(cleanup => cleanup()); mounted = false; },
    get lateUpdates() { return lateUpdates; },
    restore() { this.unmount(); Object.assign(React, originals); },
  };
}
test('default UI retains chosen settings across topic selection, tolerates denied storage and blocks duplicate starts', async () => {
  const originalOptions = optionModule.fetchPracticeOptions;
  const originalStart = LanguagePracticeClient.prototype.createSession;
  const originalProfile = authSession.currentProfile;
  authSession.currentProfile = { ownerId: id, name: 'Student', email: 'student@example.com', role: 'student' };
  optionModule.fetchPracticeOptions = async () => options;
  const calls = []; const pending = deferred();
  LanguagePracticeClient.prototype.createSession = input => { calls.push(input); return pending.promise; };
  const h = harness(LanguagePracticeSetupView);
  try {
    h.render(); await h.effects();
    let tree = h.render();
    find(tree, node => node.type === PracticeSettingsDialog).props.onSave({ level: 'B2', durationMinutes: 10, difficulty: 'medium' });
    tree = h.render();
    assert.match(text(tree), /Browser storage is unavailable/);
    find(tree, node => node.type === DefaultTopicTiles).props.onSelect('work', 'medium');
    tree = h.render();
    const start = find(tree, node => text(node) === 'Start practice');
    start.props.onClick(); start.props.onClick();
    assert.deepEqual(calls, [{ topic: 'work', level: 'B2', durationMinutes: 10, difficulty: 'medium' }]);
    assert.equal(find(h.render(), node => text(node) === 'Starting practice…').props.disabled, true);
    assert.equal(find(h.render(), node => node.type === PracticeCatalogue).props.disabled, true, 'cannot admit a custom session while a default session is pending');
    pending.resolve({ id }); await new Promise(done => setImmediate(done));
    assert.equal(navigate.at(-1), `/language-practice/sessions/${id}`);
  } finally { h.restore(); optionModule.fetchPracticeOptions = originalOptions; LanguagePracticeClient.prototype.createSession = originalStart; authSession.currentProfile = originalProfile; }
});
test('settings drafts cancel without changing defaults, and save level/duration/difficulty only', () => {
  const saved = [];
  const value = { level: 'A1', durationMinutes: 5, difficulty: 'medium' };
  const h = harness(() => PracticeSettingsDialog({ options, value, onSave: next => saved.push(next) }));
  try {
    let tree = h.render(); tree.props.onOpenChange(true); tree = h.render();
    const selects = nodes(tree).filter(node => node.type === 'select');
    selects[0].props.onChange({ target: { value: 'C2' } });
    tree.props.onOpenChange(false);
    assert.deepEqual(saved, []);
    tree = h.render(); tree.props.onOpenChange(true); tree = h.render();
    assert.equal(nodes(tree).find(node => node.type === 'select').props.value, 'A1');
    nodes(tree).filter(node => node.type === 'select')[1].props.onChange({ target: { value: '15' } });
    find(h.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    assert.deepEqual(saved, [{ level: 'A1', durationMinutes: 15, difficulty: 'medium' }]);
  } finally { h.restore(); }
});
test('challenge confirms fixed requirements before exact custom start and retains safe retry after failure', async () => {
  const original = LanguagePracticeClient.prototype.createCustomSession;
  const practice = { id, teacherId: id, teacherName: 'Teacher', title: 'Fixed challenge', setup: { topic: 'travel', level: 'C1', durationMinutes: 15 }, parameters: [{ id, requirement: 'Ask directions first' }] };
  const card = React.Children.toArray(PracticeCards({ practices: [practice] }).props.children)[0];
  const calls = []; const pending = deferred();
  LanguagePracticeClient.prototype.createCustomSession = input => { calls.push(input); return pending.promise; };
  const h = harness(() => card.type(card.props));
  try {
    let tree = h.render();
    assert.deepEqual(calls, []);
    tree.props.onOpenChange(true); tree = h.render();
    assert.match(text(tree), /fixed settings and conversation requirements/);
    const details = find(tree, node => node.props?.practice === practice);
    assert.equal(details.props.practice.setup.level, 'C1');
    const start = find(tree, node => text(node) === 'Start practice');
    start.props.onClick(); start.props.onClick();
    assert.deepEqual(calls, [{ practiceId: id }]);
    pending.reject(Error('private diagnostic')); await new Promise(done => setImmediate(done));
    assert.match(text(h.render()), /session was not confirmed/);
    assert.doesNotMatch(text(h.render()), /private diagnostic/);
    assert.equal(find(h.render(), node => text(node) === 'Start practice').props.disabled, false);
  } finally { h.restore(); LanguagePracticeClient.prototype.createCustomSession = original; }
});
test('held custom start locks the parent in both directions, recovers on failure and ignores late unmounted completion', async () => {
  const originals = {
    options: optionModule.fetchPracticeOptions,
    list: LanguagePracticeClient.prototype.listPractices,
    custom: LanguagePracticeClient.prototype.createCustomSession,
    start: LanguagePracticeClient.prototype.createSession,
  };
  const practice = { id, teacherId: id, teacherName: 'Teacher', title: 'Challenge', setup: { topic: 'travel', level: 'C1', durationMinutes: 15 }, parameters: [{ id, requirement: 'Ask directions' }] };
  optionModule.fetchPracticeOptions = async () => options;
  LanguagePracticeClient.prototype.listPractices = async () => [practice];
  const customRequests = []; const defaultRequests = [];
  LanguagePracticeClient.prototype.createCustomSession = input => { const request = deferred(); customRequests.push({ input, ...request }); return request.promise; };
  LanguagePracticeClient.prototype.createSession = input => { const request = deferred(); defaultRequests.push({ input, ...request }); return request.promise; };
  const parent = harness(LanguagePracticeSetupView);
  let catalogueProps; let cardProps;
  const catalogue = harness(() => PracticeCatalogue(catalogueProps));
  let card; let child;
  function parentTree() {
    const tree = parent.render();
    catalogueProps = find(tree, node => node.type === PracticeCatalogue).props;
    return tree;
  }
  function cardTree() {
    const cards = find(catalogue.render(), node => node.type === PracticeCards);
    card = React.Children.toArray(PracticeCards(cards.props).props.children)[0];
    cardProps = card.props;
    return child.render();
  }
  function assertControls(tree, disabled) {
    assert.equal(find(tree, node => node.type === DefaultTopicTiles).props.disabled, disabled);
    assert.equal(find(tree, node => node.type === PracticeSettingsDialog).props.disabled, disabled);
    assert.equal(find(tree, node => node.type === PracticeCatalogue).props.disabled, disabled);
  }
  try {
    parentTree(); await parent.effects();
    find(parentTree(), node => node.type === DefaultTopicTiles).props.onSelect('work', 'easy');
    parentTree();
    catalogue.render(); await catalogue.effects();
    const cards = find(catalogue.render(), node => node.type === PracticeCards);
    card = React.Children.toArray(PracticeCards(cards.props).props.children)[0]; cardProps = card.props;
    child = harness(() => card.type(cardProps));
    let tree = child.render(); await child.effects();
    const staleDefault = find(parentTree(), node => text(node) === 'Start practice');
    tree.props.onOpenChange(true); tree = child.render();
    const staleCustom = find(tree, node => text(node) === 'Start practice');
    staleCustom.props.onClick(); staleCustom.props.onClick(); staleDefault.props.onClick();
    assert.equal(customRequests.length, 1);
    assert.equal(defaultRequests.length, 0, 'a held custom POST must prevent default admission');
    assert.deepEqual(customRequests[0].input, { practiceId: id });
    assertControls(parentTree(), true);
    tree = cardTree();
    assert.equal(find(tree, node => text(node) === 'Starting practice…').props.disabled, true);
    customRequests[0].reject(Error('not confirmed')); await new Promise(done => setImmediate(done));
    assertControls(parentTree(), false); cardTree();
    staleDefault.props.onClick(); staleCustom.props.onClick();
    assert.equal(defaultRequests.length, 1);
    assert.equal(customRequests.length, 1, 'a held default POST must prevent stale custom admission');
    parentTree(); tree = cardTree();
    assertControls(parentTree(), true);
    defaultRequests[0].reject(Error('not confirmed')); await new Promise(done => setImmediate(done));
    assertControls(parentTree(), false); tree = cardTree();
    find(tree, node => text(node) === 'Start practice').props.onClick();
    assertControls(parentTree(), true);
    child.unmount();
    assertControls(parentTree(), true);
    // Unmounting a card must not admit another start while its POST is still held.
    find(parentTree(), node => text(node) === 'Start practice').props.onClick();
    assert.equal(defaultRequests.length, 1);
    const navigationCount = navigate.length;
    customRequests[1].resolve({ id }); await new Promise(done => setImmediate(done));
    assert.equal(navigate.length, navigationCount, 'no late navigation after card unmount');
    assert.equal(child.lateUpdates, 0);
    assertControls(parentTree(), false);
    find(parentTree(), node => text(node) === 'Start practice').props.onClick();
    const pendingTree = parentTree();
    assert.equal(find(pendingTree, node => node.type === PracticeSettingsDialog).props.disabled, true);
    assert.equal(find(pendingTree, node => node.type === DefaultTopicTiles).props.disabled, true);
    parent.unmount();
    defaultRequests[1].resolve({ id }); await new Promise(done => setImmediate(done));
    assert.equal(navigate.length, navigationCount, 'no late default navigation after parent unmount');
    assert.equal(parent.lateUpdates, 0);
  } finally {
    child?.restore(); catalogue.restore(); parent.restore();
    optionModule.fetchPracticeOptions = originals.options;
    LanguagePracticeClient.prototype.listPractices = originals.list;
    LanguagePracticeClient.prototype.createCustomSession = originals.custom;
    LanguagePracticeClient.prototype.createSession = originals.start;
  }
});
for (const leave of ['unmount', 'route-change', 'mounted-retry']) {
  test(`standalone detail held start respects ${leave} lifecycle`, async () => {
    const originalGet = LanguagePracticeClient.prototype.getPractice;
    const originalStart = LanguagePracticeClient.prototype.createCustomSession;
    const nextId = '123e4567-e89b-42d3-a456-426614174001';
    routeParams = { practiceId: id };
    const requests = [];
    LanguagePracticeClient.prototype.getPractice = async practiceId => ({ id: practiceId, teacherId: id, teacherName: 'Teacher', title: 'Fixed challenge', setup: { topic: 'travel', level: 'C1', durationMinutes: 15 }, parameters: [{ id, requirement: 'Ask directions' }] });
    LanguagePracticeClient.prototype.createCustomSession = input => {
      const request = deferred(); requests.push({ input, ...request }); return request.promise;
    };
    const h = harness(CustomPracticeView);
    try {
      h.render(); await h.effects();
      let tree = h.render();
      assert.equal(find(tree, node => node.props?.practice).props.practice.setup.level, 'C1');
      const start = find(tree, node => text(node) === 'Start teacher practice');
      start.props.onClick(); start.props.onClick();
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].input, { practiceId: id });
      tree = h.render();
      assert.equal(find(tree, node => text(node) === 'Starting practice…').props.disabled, true);
      const back = find(tree, node => node.props?.to === '/language-practice');
      assert.equal(back.props.onClick, undefined, 'Return link remains usable during the POST');
      const navigationCount = navigate.length;
      if (leave === 'unmount') {
        h.unmount(); requests[0].resolve({ id });
        await new Promise(done => setImmediate(done));
        assert.equal(navigate.length, navigationCount, 'late success must not undo Return navigation');
        assert.equal(h.lateUpdates, 0);
      } else if (leave === 'route-change') {
        h.restartEffects(); routeParams = { practiceId: nextId };
        h.render(); await h.effects(); tree = h.render();
        find(tree, node => text(node) === 'Start teacher practice').props.onClick();
        assert.deepEqual(requests[1].input, { practiceId: nextId });
        requests[0].resolve({ id }); await new Promise(done => setImmediate(done));
        assert.equal(navigate.length, navigationCount, 'old route success must not navigate');
        assert.equal(find(h.render(), node => text(node) === 'Starting practice…').props.disabled, true, 'old settlement cannot clear the new route pending state');
        requests[1].resolve({ id: nextId }); await new Promise(done => setImmediate(done));
        assert.equal(navigate.at(-1), `/language-practice/sessions/${nextId}`);
      } else {
        requests[0].reject(Error('not confirmed')); await new Promise(done => setImmediate(done));
        tree = h.render(); assert.match(text(tree), /session was not confirmed/);
        find(tree, node => text(node) === 'Start teacher practice').props.onClick();
        requests[1].resolve({ id }); await new Promise(done => setImmediate(done));
        assert.equal(navigate.at(-1), `/language-practice/sessions/${id}`);
      }
    } finally {
      h.restore(); routeParams = {};
      LanguagePracticeClient.prototype.getPractice = originalGet;
      LanguagePracticeClient.prototype.createCustomSession = originalStart;
    }
  });
}
test('teacher table shows unavailable reports and never labels a nullable completion as a finish', () => {
  const base = { sessionId: id, studentId: id, studentName: '<script>Student</script>', studentEmail: 'student@example.com', status: 'EXPIRED', startedAt: date, completedAt: null, reportAvailable: false };
  let html = renderToStaticMarkup(React.createElement(SubmissionsTable, { practiceId: id, submissions: [base] }));
  assert.match(html, /Not recorded/); assert.match(html, /Not available/); assert.match(html, /Expired/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /View report/);
  html = renderToStaticMarkup(React.createElement(SubmissionsTable, { practiceId: id, submissions: [{ ...base, reportAvailable: true }] }));
  assert.match(html, new RegExp(`/teacher/practices/${id}/results/${id}`));
  assert.equal((html.match(/<time/g) ?? []).length, 1, 'only startedAt exists, not a fabricated completion time');
});
test('table optional report callback replaces only available report links and keeps default route behavior', () => {
  const available = { sessionId: id, studentName: 'Student', startedAt: date, completedAt: null, reportAvailable: true };
  const unavailable = { ...available, sessionId: 'other', reportAvailable: false };
  const calls = [];
  const tree = SubmissionsTable({ practiceId: id, submissions: [available, unavailable], onViewReport: entry => calls.push(entry) });
  const controls = nodes(tree).filter(node => node.type === 'button');
  assert.equal(controls.length, 1);
  assert.equal(controls[0].props.type, 'button');
  assert.match(controls[0].props['aria-label'], /Student, started/);
  controls[0].props.onClick();
  assert.deepEqual(calls, [available]);
  assert.equal(nodes(tree).filter(node => node.props?.to).length, 0);
  assert.match(text(tree), /Not available/);
});

test('saved browser filters ownership, retries, navigates one dialog and ignores stale results after Back or Close', async () => {
  const originals = { list: LanguagePracticeClient.prototype.listPractices, submissions: TeacherResultsClient.prototype.listSubmissions, report: TeacherResultsClient.prototype.getReport, profile: authSession.currentProfile };
  authSession.currentProfile = { ownerId: id, name: 'Teacher', email: 'teacher@example.com', role: 'teacher' };
  const owned = { id, teacherId: id, teacherName: 'Teacher', title: 'Owned practice', setup: { level: 'B2', durationMinutes: 10 }, parameters: [] };
  const foreign = { ...owned, id: 'other', teacherId: 'other', title: 'Foreign practice' };
  const student = { sessionId: id, studentName: 'Student', studentEmail: 'student@example.com', startedAt: date, completedAt: null, reportAvailable: true };
  const lists = []; const entries = []; const reports = [];
  LanguagePracticeClient.prototype.listPractices = () => { const request = deferred(); lists.push(request); return request.promise; };
  TeacherResultsClient.prototype.listSubmissions = practiceId => { assert.equal(practiceId, id); const request = deferred(); entries.push(request); return request.promise; };
  TeacherResultsClient.prototype.getReport = (practiceId, sessionId) => { assert.equal(practiceId, id); assert.equal(sessionId, id); const request = deferred(); reports.push(request); return request.promise; };
  const h = harness(() => TeacherPracticesDialog({}));
  async function commitEffects() { h.restartEffects(); h.render(); await h.effects(); return h.render(); }
  const flush = () => new Promise(done => setImmediate(done));
  try {
    let tree = h.render(); await h.effects();
    assert.equal(lists.length, 0, 'closed browser does not fetch');
    tree.props.onOpenChange(true); tree = await commitEffects();
    assert.match(text(tree), /Loading saved results/);
    lists[0].resolve([foreign]); await flush(); tree = h.render();
    assert.match(text(tree), /No practices created yet/);
    assert.equal(nodes(tree).filter(node => node.props?.practice).length, 0);
    tree.props.onOpenChange(false); await commitEffects();
    h.render().props.onOpenChange(true); await commitEffects();
    lists[1].reject(Error('private details')); await flush(); tree = h.render();
    assert.match(text(tree), /Saved results could not be loaded/);
    assert.doesNotMatch(text(tree), /private details/);
    find(tree, node => text(node) === 'Try again').props.onClick(); await commitEffects();
    lists[2].resolve([foreign, owned]); await flush(); tree = h.render();
    assert.deepEqual(nodes(tree).filter(node => node.props?.practice).map(node => node.props.practice), [owned]);
    find(tree, node => text(node).startsWith('View submissions')).props.onClick(); await commitEffects();
    entries[0].resolve([student]); await flush(); tree = h.render();
    find(tree, node => node.type === SubmissionsTable).props.onViewReport(student); await commitEffects();
    const saved = { createdAt: date, summary: 'Saved evidence' };
    reports[0].resolve(saved); await flush(); tree = h.render();
    assert.equal(find(tree, node => node.type === PracticeReportContent).props.report, saved);
    assert.match(text(tree), /Read-only persisted report/);
    find(tree, node => text(node) === 'Back').props.onClick(); tree = await commitEffects();
    assert.equal(nodes(tree).filter(node => node.type === PracticeReportContent).length, 0);
    find(tree, node => text(node) === 'Back').props.onClick(); await commitEffects();
    entries[1].resolve([student]); await flush();
    assert.equal(nodes(h.render()).filter(node => node.type === SubmissionsTable).length, 0, 'late submissions cannot replace list page');
    lists[3].resolve([owned]); await flush(); tree = h.render();
    find(tree, node => text(node).startsWith('View submissions')).props.onClick(); await commitEffects();
    h.render().props.onOpenChange(false); await commitEffects();
    h.render().props.onOpenChange(true); await commitEffects();
    entries[2].reject(Error('late error')); await flush(); tree = h.render();
    assert.match(text(tree), /Loading saved results/);
    assert.doesNotMatch(text(tree), /could not be loaded/);
    h.unmount(); lists[4].resolve([owned]); await flush();
    assert.equal(h.lateUpdates, 0, 'no updates after unmount');
  } finally {
    h.restore(); LanguagePracticeClient.prototype.listPractices = originals.list;
    TeacherResultsClient.prototype.listSubmissions = originals.submissions;
    TeacherResultsClient.prototype.getReport = originals.report;
    authSession.currentProfile = originals.profile;
  }
});

test('opening and closing saved browser preserves draft fields and preview without creating anything', () => {
  const original = LanguagePracticeClient.prototype.createPractice;
  const calls = [];
  LanguagePracticeClient.prototype.createPractice = (...args) => { calls.push(args); };
  const h = harness(TeacherPracticesView);
  try {
    let tree = h.render();
    find(tree, node => node.type === 'input' && node.props.maxLength === 120).props.onChange({ target: { value: 'Unsaved theme' } });
    find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Unsaved requirement' } });
    nodes(tree).filter(node => node.type === 'select')[0].props.onChange({ target: { value: 'C1' } });
    tree = h.render();
    nodes(tree).filter(node => node.type === 'select')[1].props.onChange({ target: { value: '15' } });
    tree = h.render();
    const { onImageError: _before, ...draft } = find(tree, node => node.type === PracticeCardPreview).props;
    const browserProps = find(tree, node => node.type === TeacherPracticesDialog).props;
    const browser = harness(() => TeacherPracticesDialog(browserProps));
    try {
      browser.render().props.onOpenChange(true);
      browser.render().props.onOpenChange(false);
    } finally { browser.restore(); }
    tree = h.render();
    const { onImageError: _after, ...after } = find(tree, node => node.type === PracticeCardPreview).props;
    assert.deepEqual(after, draft);
    assert.equal(draft.title, 'Unsaved theme');
    assert.deepEqual(draft.setup, { level: 'C1', durationMinutes: 15, difficulty: 'medium' });
    assert.deepEqual(draft.requirements, ['Unsaved requirement']);
    assert.deepEqual(calls, []);
  } finally { h.restore(); LanguagePracticeClient.prototype.createPractice = original; }
});

test('shared report renders exact evidence and empty states without student-mutating actions', () => {
  const report = { sessionId: id, summary: '<script>Summary</script>', corrections: [], strengths: [], recommendations: [], generatedWithAi: true, createdAt: date, parameterCoverage: [{ parameterId: id, requirement: 'Ask directions', status: 'unassessed', evidenceSequences: [], explanation: 'Insufficient evidence' }] };
  const html = renderToStaticMarkup(React.createElement(PracticeReportContent, { report }));
  for (const phrase of ['Performance summary', 'No evidence-backed corrections', 'Observed strengths', 'Next practice', 'Not assessed', 'Insufficient evidence', '&lt;script&gt;']) assert.ok(html.includes(phrase), phrase);
  assert.doesNotMatch(html, /Finish practice|Start recording|Start practice|<script>/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/features/teacher/TeacherResultsView.tsx'), 'utf8'), /<PracticeReportContent report=\{report\} \/>/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/features/language-practice/PracticeReportView.tsx'), 'utf8'), /<PracticeReportContent report=\{report\} session=\{session\} learningSupport=\{learningSupport\}/);
});
