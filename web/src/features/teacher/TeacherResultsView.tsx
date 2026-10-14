import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { RoleHeader } from '../auth/RoleHeader';
import { LanguagePracticeClient, LanguagePracticeClientError, type TeacherPractice, type LanguagePracticeReport } from '../language-practice/language-practice-client';
import { PracticeReportContent } from '../language-practice/PracticeReportContent';
import { TeacherResultsClient, type PracticeSubmission } from './teacher-results-client';

function timestamp(value: string) { return new Date(value).toLocaleString(); }
export function SubmissionsTable({ submissions, practiceId, onViewReport }: {
  submissions: PracticeSubmission[];
  practiceId: string;
  onViewReport?: (submission: PracticeSubmission) => void;
}) {
  if (!submissions.length) return <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">No students have started this challenge yet.</p>;
  return <div className="overflow-x-auto rounded-xl border bg-card" role="region" aria-label="Student attempts" tabIndex={0}>
    <table className="w-full min-w-[720px] text-left text-sm"><caption className="sr-only">Student attempts for the selected challenge</caption>
      <thead className="bg-muted/50"><tr>{['Student', 'Status', 'Started', 'Completed', 'Report'].map(label => <th key={label} scope="col" className="px-4 py-3 font-semibold">{label}</th>)}</tr></thead>
      <tbody>{submissions.map(item => <tr key={item.sessionId} className="border-t">
        <td className="max-w-64 break-words px-4 py-4"><p className="font-medium">{item.studentName}</p><p className="text-muted-foreground">{item.studentEmail}</p></td>
        <td className="px-4 py-4">{item.status === 'ACTIVE' ? 'In progress' : item.status === 'COMPLETED' ? 'Completed' : 'Expired'}</td>
        <td className="px-4 py-4"><time dateTime={item.startedAt}>{timestamp(item.startedAt)}</time></td>
        <td className="px-4 py-4">{item.completedAt === null ? <span className="text-muted-foreground">Not recorded</span> : <time dateTime={item.completedAt}>{timestamp(item.completedAt)}</time>}</td>
        <td className="px-4 py-4">{item.reportAvailable ? onViewReport
          ? <button type="button" className="font-medium text-primary underline underline-offset-4 focus-visible:ring-4 focus-visible:ring-ring/50" aria-label={`View report for ${item.studentName}, started ${timestamp(item.startedAt)}`} onClick={() => onViewReport(item)}>View report</button>
          : <Link className="font-medium text-primary underline underline-offset-4" aria-label={`View report for ${item.studentName}, started ${timestamp(item.startedAt)}`} to={`/teacher/practices/${practiceId}/results/${item.sessionId}`}>View report</Link>
          : <span className="text-muted-foreground">Not available</span>}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
export function TeacherResultsView() {
  const { practiceId = '', sessionId } = useParams<{ practiceId: string; sessionId: string }>();
  const practicesClient = useMemo(() => new LanguagePracticeClient(authSession), []);
  const resultsClient = useMemo(() => new TeacherResultsClient(authSession), []);
  const [practice, setPractice] = useState<TeacherPractice | null>(null);
  const [submissions, setSubmissions] = useState<PracticeSubmission[] | null>(null);
  const [report, setReport] = useState<LanguagePracticeReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setPractice(null); setSubmissions(null); setReport(null); setError(''); setLoading(true);
    async function load() {
      try {
        const selected = await practicesClient.getPractice(practiceId);
        // The API enforces ownership; no role header is used as authorization.
        if (active) setPractice(selected);
        const entries = await resultsClient.listSubmissions(practiceId);
        if (active) setSubmissions(entries);
        const saved = sessionId ? await resultsClient.getReport(practiceId, sessionId) : null;
        if (active) setReport(saved);
      } catch (failure) {
        if (active) setError(failure instanceof LanguagePracticeClientError && failure.kind === 'not-found'
          ? 'This challenge or saved report is not available. Reports are never generated from this page.'
          : failure instanceof LanguagePracticeClientError ? failure.message : 'Results could not be loaded.');
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [practiceId, sessionId, attempt, practicesClient, resultsClient]);
  const student = submissions?.find(item => item.sessionId === sessionId);
  return <main className="authenticated-page [overflow-wrap:anywhere]">
    <RoleHeader title={sessionId ? 'Saved student report' : 'Challenge results'} description="Read-only evidence from student attempts on your challenge." />
    <nav className="mb-6"><Link className="text-sm text-primary underline" to={sessionId ? `/teacher/practices/${practiceId}/results` : '/teacher'}>{sessionId ? 'Back to challenge results' : 'Back to your practices'}</Link></nav>
    {loading && <p className="rounded-xl border bg-card p-5 text-sm" role="status">Loading saved results…</p>}
    {!loading && error && <div className="rounded-xl border p-5" role="alert"><p>{error}</p><Button variant="outline" className="mt-3" onClick={() => setAttempt(current => current + 1)}>Try again</Button></div>}
    {!loading && practice && <header className="mb-6 rounded-xl border bg-primary/5 p-5"><h2 className="text-xl font-semibold break-words">{practice.title}</h2><p className="mt-1 text-sm text-muted-foreground">{practice.setup.level} · {practice.setup.durationMinutes} minutes · {practice.setup.topic.replaceAll('-', ' ')}</p>
      {student && <p className="mt-3 text-sm break-words">{student.studentName} · {student.studentEmail}<br />Started {timestamp(student.startedAt)} · Completed {student.completedAt ? timestamp(student.completedAt) : 'not recorded'}</p>}
    </header>}
    {!loading && report && <><p className="mb-4 text-sm text-muted-foreground">Read-only persisted report · Saved <time dateTime={report.createdAt}>{timestamp(report.createdAt)}</time></p><PracticeReportContent report={report} /></>}
    {!loading && !sessionId && submissions && <SubmissionsTable submissions={submissions} practiceId={practiceId} />}
  </main>;
}
