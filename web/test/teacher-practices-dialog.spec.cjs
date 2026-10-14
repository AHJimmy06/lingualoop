const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = file => fs.readFileSync(path.join(__dirname, '../src/features', file), 'utf8');

test('saved practice browser uses one bounded BaseUI dialog and accessible internal navigation', () => {
  const view = source('teacher/TeacherPracticesDialog.tsx');
  for (const part of ['Root', 'Trigger', 'Popup', 'Title', 'Description', 'Close']) {
    assert.equal((view.match(new RegExp(`<Dialog\\.${part}\\b`, 'g')) || []).length, 1, part);
  }
  assert.match(view, /from '@base-ui\/react\/dialog'/);
  assert.match(view, /View created practices/);
  assert.match(view, /max-h-\[90svh\].*w-\[calc\(100%_-_2rem\)\].*max-w-7xl.*flex-col overflow-hidden/);
  assert.match(view, /ref=\{scrollArea\} className="min-h-0 min-w-0 overflow-y-auto/);
  assert.match(view, /initialFocus=\{heading\}/);
  assert.match(view, /scrollArea.current.scrollTop = 0/);
  assert.match(view, /finalFocus=\{trigger\}/);
  assert.match(view, /tabIndex=\{-1\}/);
  assert.match(view, /heading.current\?\.focus\(\)/);
  assert.match(view, />Back</);
  assert.match(view, />Close</);
});

test('browser isolates GET-only saved evidence, filters before empty checks and guards stale requests', () => {
  const view = source('teacher/TeacherPracticesDialog.tsx');
  assert.match(view, /TeacherResultsClient/);
  assert.match(view, /listSubmissions\(selection.practice.id\)/);
  assert.match(view, /getReport\(selection.practice.id, selection.sessionId\)/);
  assert.match(view, /practice.teacherId === ownerId/);
  assert.match(view, /ownedPractices.length === 0/);
  assert.match(view, /return \(\) => \{ active = false; \}/);
  assert.match(view, /if \(!active\) return/);
  assert.match(view, /Loading saved results/);
  assert.match(view, /Try again/);
  assert.match(view, /<PracticeReportContent report=\{report\} \/>/);
  assert.match(view, /Read-only persisted report/);
  assert.doesNotMatch(view, /createSession|createCustomSession|createPractice|generateReport|<PracticeCards|<Dialog.Root[\s\S]*<Dialog.Root/);
});

test('creation owns draft state independently of results browser visibility', () => {
  const view = source('teacher/TeacherPracticesView.tsx');
  assert.match(view, /<PracticeCardPreview title=\{title\} setup=\{setup\} requirements=\{requirements\}/);
  assert.match(view, /<TeacherPracticesDialog/);
  assert.ok(view.indexOf('<TeacherPracticesDialog') > view.indexOf('</form>'));
  assert.doesNotMatch(view, /listPractices\(|<PracticeDetails|<Link/);
});
