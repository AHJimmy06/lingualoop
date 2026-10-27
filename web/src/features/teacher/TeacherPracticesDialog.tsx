import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { PracticeDetails } from '../language-practice/PracticeCatalogue';
import { PracticeReportContent } from '../language-practice/PracticeReportContent';
import { LanguagePracticeClient, LanguagePracticeClientError, type LanguagePracticeReport, type TeacherPractice } from '../language-practice/language-practice-client';
import { SubmissionsTable } from './TeacherResultsView';
import { TeacherResultsClient, type PracticeSubmission } from './teacher-results-client';

type Selection = { page: 'list' }
  | { page: 'submissions'; practice: TeacherPractice }
  | { page: 'report'; practice: TeacherPractice; sessionId: string; student: PracticeSubmission };

function timestamp(value: string) { return new Date(value).toLocaleString(); }

/** One read-only browser; navigation never changes the create form's draft. */
export function TeacherPracticesDialog({ catalogueVersion = 0 }: { catalogueVersion?: number }) {
  const practicesClient = useMemo(() => new LanguagePracticeClient(authSession), []);
  const resultsClient = useMemo(() => new TeacherResultsClient(authSession), []);
  const ownerId = authSession.profile?.ownerId;
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Selection>({ page: 'list' });
  const [practices, setPractices] = useState<TeacherPractice[]>([]);
  const [submissions, setSubmissions] = useState<PracticeSubmission[]>([]);
  const [report, setReport] = useState<LanguagePracticeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);

  function navigate(next: Selection) {
    // Hide the old evidence immediately, including before the next effect runs.
    setLoading(true);
    setError('');
    setReport(null);
    setSubmissions([]);
    setSelection(next);
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError('');
    setPractices([]);
    setSubmissions([]);
    setReport(null);
    async function load() {
      try {
        if (selection.page === 'list') {
          const saved = await practicesClient.listPractices();
          if (!active) return;
          setPractices(saved);
        } else {
          // A client filter is presentation only; the GET endpoints enforce ownership.
          if (!ownerId || selection.practice.teacherId !== ownerId) {
            throw new LanguagePracticeClientError('not-found');
          }
          if (selection.page === 'submissions') {
            const entries = await resultsClient.listSubmissions(selection.practice.id);
            if (!active) return;
            setSubmissions(entries);
          } else {
            const saved = await resultsClient.getReport(selection.practice.id, selection.sessionId);
            if (!active) return;
            setReport(saved);
          }
        }
      } catch (failure) {
        if (!active) return;
        setError(failure instanceof LanguagePracticeClientError && failure.kind === 'not-found'
          ? 'This practice or saved report is not available. Reports are never generated from this dialog.'
          : failure instanceof LanguagePracticeClientError ? failure.message : 'Saved results could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [open, selection, attempt, catalogueVersion, ownerId, practicesClient, resultsClient]);

  useEffect(() => {
    if (open) {
      heading.current?.focus();
      if (scrollArea.current) scrollArea.current.scrollTop = 0;
    }
  }, [open, selection]);

  // Use the same owned collection for both display and the empty state.
  const ownedPractices = practices.filter(practice => practice.teacherId === ownerId);
  const title = selection.page === 'list' ? 'Your created practices'
    : selection.page === 'submissions' ? 'Practice submissions' : 'Saved student report';
  return <Dialog.Root open={open} onOpenChange={next => {
    navigate({ page: 'list' });
    setOpen(next);
  }}>
    <Dialog.Trigger ref={trigger} render={<Button variant="outline" />}>View created practices</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
      <Dialog.Popup initialFocus={heading} finalFocus={trigger} className="fixed left-1/2 top-1/2 z-50 flex max-h-[90svh] w-[calc(100%_-_2rem)] max-w-7xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border bg-card shadow-xl">
        <div className="shrink-0 border-b p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <Dialog.Title ref={heading} tabIndex={-1} className="min-w-0 text-xl font-semibold outline-none [overflow-wrap:anywhere]">{title}</Dialog.Title>
            <div className="flex shrink-0 gap-2">
              {selection.page !== 'list' && <Button variant="outline" onClick={() => navigate(selection.page === 'report' ? { page: 'submissions', practice: selection.practice } : { page: 'list' })}>Back</Button>}
              <Dialog.Close render={<Button variant="outline" />}>Close</Dialog.Close>
            </div>
          </div>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">Read-only saved practices and student evidence. Your unsaved draft stays unchanged.</Dialog.Description>
        </div>
        <div ref={scrollArea} className="min-h-0 min-w-0 overflow-y-auto p-4 [overflow-wrap:anywhere] sm:p-6">
          {selection.page !== 'list' && <header className="mb-5 min-w-0 rounded-xl border bg-primary/5 p-5">
            <h2 className="text-lg font-semibold">{selection.practice.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{selection.practice.setup.level} · {selection.practice.setup.durationMinutes} minutes</p>
            {selection.page === 'report' && <p className="mt-3 text-sm">{selection.student.studentName} · {selection.student.studentEmail}<br />Started {timestamp(selection.student.startedAt)} · Completed {selection.student.completedAt ? timestamp(selection.student.completedAt) : 'not recorded'}</p>}
          </header>}
          {loading ? <p role="status">Loading saved results…</p>
            : error ? <div role="alert"><p>{error}</p><Button className="mt-3" variant="outline" onClick={() => { setLoading(true); setError(''); setAttempt(value => value + 1); }}>Try again</Button></div>
            : selection.page === 'list' ? ownedPractices.length === 0 ? <p>No practices created yet.</p>
              : <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] items-start gap-4">{ownedPractices.map(practice => <div key={practice.id} className="grid min-w-0 grid-cols-1 gap-2">
                <PracticeDetails practice={practice} showTeacherContext />
                <Button className="w-fit" variant="outline" onClick={() => navigate({ page: 'submissions', practice })}>View submissions<span className="sr-only"> for {practice.title}</span></Button>
              </div>)}</div>
            : selection.page === 'submissions' ? <SubmissionsTable submissions={submissions} practiceId={selection.practice.id} onViewReport={student => navigate({ page: 'report', practice: selection.practice, sessionId: student.sessionId, student })} />
            : report && <><p className="mb-4 text-sm text-muted-foreground">Read-only persisted report · Saved <time dateTime={report.createdAt}>{timestamp(report.createdAt)}</time></p><PracticeReportContent report={report} /></>}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
