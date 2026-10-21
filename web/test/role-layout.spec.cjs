const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = file => fs.readFileSync(path.join(__dirname, '../src/features', file), 'utf8');

// Source contracts only: browser verification owns computed sizes and overflow.
test('both logout buttons retain text and pending guards with a decorative icon', () => {
  for (const [file, pending] of [['auth/RoleHeader.tsx', 'busy'], ['language-practice/LanguagePracticeSetupView.tsx', 'loggingOut']]) {
    const view = source(file);
    assert.match(view, /import \{[^}]*LogOut[^}]*\} from 'lucide-react'/);
    assert.match(view, /<LogOut className="size-4" aria-hidden="true" \/>/);
    assert.ok(view.includes(`{${pending} ? 'Signing out…' : 'Log out'}`));
    assert.match(view, /onClick=\{\(\) => void logout\(\)\}/);
    assert.ok(view.includes(file.startsWith('auth/') ? 'disabled={busy}' : 'disabled={loggingOut || starting}'));
    assert.ok(view.includes(file.startsWith('auth/') ? 'if (busy) return;' : 'if (loggingOut || pending.current) return;'));
    assert.match(view, /flex flex-wrap items-end justify-between gap-5/);
  }
});

test('student browse uses viewport width, intentional gutters and at most two desktop columns', () => {
  const setup = source('language-practice/LanguagePracticeSetupView.tsx');
  assert.match(setup, /<main className="authenticated-page \[overflow-wrap:anywhere\]"/);
  assert.match(setup, /grid-cols-1 gap-4 lg:grid-cols-2/);
  assert.doesNotMatch(setup, /auto-fill|auto-fit|sm:grid-cols-2/);
  assert.match(setup, /aria-label="All available practices">[\s\S]*<DefaultTopicTiles[\s\S]*<PracticeCatalogue/);
  assert.doesNotMatch(source('language-practice/PracticeCatalogue.tsx'), /Teacher-created practices|mt-8 border-t/);
  assert.match(setup, /flex flex-wrap items-center gap-2/);
  assert.match(setup, /sm:min-h-52/);
  assert.match(source('language-practice/PracticeCatalogue.tsx'), /h-32 w-full object-cover sm:h-40/);
});

test('teacher creation stays readable beside a draft preview, with saved catalogue only in a dialog', () => {
  const view = source('teacher/TeacherPracticesView.tsx');
  assert.match(view, /<main className="authenticated-page \[overflow-wrap:anywhere\]"/);
  assert.match(view, /xl:grid-cols-\[minmax\(0,42rem\)_minmax\(0,1fr\)\]/);
  assert.match(view, /<form className="grid w-full min-w-0 max-w-3xl/);
  assert.match(view, /sm:grid-cols-2/);
  assert.match(view, /<PracticeCardPreview/);
  const dialog = source('teacher/TeacherPracticesDialog.tsx');
  assert.match(dialog, /grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,20rem\),1fr\)\)\]/);
});

test('results and saved reports expand with authenticated spacing and local table scrolling', () => {
  const view = source('teacher/TeacherResultsView.tsx');
  assert.match(view, /<main className="authenticated-page \[overflow-wrap:anywhere\]"/);
  assert.doesNotMatch(view, /max-w-3xl|max-w-5xl/);
  assert.match(view, /overflow-x-auto rounded-xl border bg-card/);
  assert.match(view, /w-full min-w-\[720px\]/);
  assert.match(view, /<PracticeReportContent report=\{report\} \/>/);
});

test('teacher detail text can shrink inside nested grids and wrap unbroken valid values', () => {
  const catalogue = source('language-practice/PracticeCatalogue.tsx');
  assert.match(catalogue, /<article className="min-w-0[^"\n]*\[overflow-wrap:anywhere\]/);
  assert.match(source('teacher/TeacherPracticesDialog.tsx'), /<div key=\{practice.id\} className="grid min-w-0 grid-cols-1 gap-2"/);
  assert.match(source('language-practice/PracticeCardPreview.tsx'), /\[overflow-wrap:anywhere\]/);
  assert.doesNotMatch(catalogue.slice(catalogue.indexOf('export function PracticeDetails'), catalogue.indexOf('export type ClaimPracticeStart')), /overflow-hidden|truncate|line-clamp/);
});

test('student card text uses a shrinkable grid and explicit wrapping title, not clipped anonymous flex text', () => {
  const view = source('language-practice/PracticeCatalogue.tsx');
  assert.match(view, /<Dialog\.Trigger disabled=\{disabled\} className="group block min-w-0 w-full overflow-hidden whitespace-normal/);
  assert.match(view, /<span className="grid min-w-0 grid-cols-1[^"\n]*\[overflow-wrap:anywhere\]/);
  assert.match(view, /<span className="min-w-0 flex-1">\{practice.title\}<\/span><span className="text-xs font-medium text-primary">View details/);
  assert.doesNotMatch(view, /truncate|line-clamp/);
});

test('authenticated spacing is opt-in and matches the existing wide browse gutters', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');
  assert.match(css, /@utility authenticated-page\s*\{\s*@apply w-full min-w-0 px-4 py-8 sm:px-6 sm:py-12 lg:px-8;[\s\S]*?background-image:/);
  assert.doesNotMatch(css, /(?:^|\n)\s*main\s*\{/);
  assert.doesNotMatch(source('auth/LoginView.tsx'), /authenticated-page/);
});

test('admin stacks on mobile and bounds the desktop form beside a shrinkable account list', () => {
  const view = source('admin/AdminAccountsView.tsx');
  assert.match(view, /<main className="authenticated-page"/);
  assert.match(view, /grid min-w-0 items-start gap-6 lg:grid-cols-\[minmax\(0,24rem\)_minmax\(0,1fr\)\]/);
  assert.match(view, /<form[^\n]*className="grid min-w-0 gap-4/);
  assert.match(view, /<section className="min-w-0 rounded-2xl/);
  assert.match(view, /<li key=\{account.id\} className="min-w-0[^"\n]*\[overflow-wrap:anywhere\]/);
  assert.equal((view.match(/className="min-w-0 rounded-md border bg-background p-3"/g) || []).length, 4);
  assert.match(view, /onSubmit=\{event => void submit\(event\)\}/);
  assert.match(view, /disabled=\{!valid \|\| busy\}/);
  assert.match(view, /if \(!valid \|\| pending.current\) return;/);
});

test('practice card opens a details modal with requirements and start action', () => {
  const view = source('language-practice/PracticeCatalogue.tsx');
  const cards = view.slice(view.indexOf('function ChallengeCard'), view.indexOf('export function PracticeCatalogue'));
  assert.match(cards, /<Dialog\.Root open=\{open\} onOpenChange=/);
  assert.match(cards, /<Dialog\.Popup className=/);
  assert.match(cards, /<PracticeDetails practice=\{practice\} \/>/);
  assert.match(cards, /'Start practice'/);
  const detail = view.slice(view.indexOf('export function CustomPracticeView'));
  assert.match(detail, /<main className="authenticated-page \[overflow-wrap:anywhere\]"/);
  assert.match(detail, /<p className="mb-4 max-w-prose text-sm/);
  assert.match(detail, /<div className="min-w-0 \[&_h2\]:max-w-prose \[&_p\]:max-w-prose \[&_ol\]:max-w-prose"><PracticeDetails practice=\{practice\} \/><\/div>/);
  assert.doesNotMatch(detail, /max-w-3xl/);
  assert.match(detail, /disabled=\{starting\} onClick=\{\(\) => void start\(\)\}/);
  assert.match(detail, /generation === startGeneration.current/);
  assert.doesNotMatch(view.slice(0, view.indexOf('export function CustomPracticeView')), /authenticated-page|\[&_ol\]:max-w-prose/);
});
