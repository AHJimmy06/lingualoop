import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { RoleHeader } from '../auth/RoleHeader';
import { LanguagePracticeClient, type PracticeHistoryPage } from './language-practice-client';
import { difficultyLabel } from './practice-preferences';

const topics: Record<string, string> = { travel: 'Travel', work: 'Work', studies: 'Studies', 'everyday-conversation': 'Everyday conversation' };

export function PracticeHistoryView() {
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<PracticeHistoryPage | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setPage(null); setError(false);
    void client.getHistory(offset).then(value => { if (active) setPage(value); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [client, offset, attempt]);
  return <main className="authenticated-page [overflow-wrap:anywhere]">
    <RoleHeader title="My practice history" description="Review your completed conversations and return to your full feedback whenever you need it." />
    <nav className="mb-6" aria-label="Practice navigation"><Link className="text-sm font-medium text-teal-800 underline underline-offset-4" to="/language-practice">Back to practices</Link></nav>
    {error ? <section className="rounded-xl border bg-white p-6" role="alert"><p>Your practice history could not be loaded.</p><Button className="mt-3" variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button></section> : page === null ? <p role="status">Loading your practice history...</p> : <>
      {page.sessions.length === 0 ? <section className="rounded-2xl border border-dashed bg-white p-8 text-center"><h2 className="text-xl font-semibold">No completed practices yet</h2><p className="mt-2 text-sm text-slate-600">Finish a practice to find it here with its feedback.</p></section> :
        <ul className="grid min-w-0 gap-4 md:grid-cols-2">{page.sessions.map(item => <li key={item.id} className="flex min-w-0 flex-col rounded-2xl border bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold uppercase tracking-wide text-teal-800">{item.status === 'COMPLETED' ? 'Completed' : 'Time ended'}</span><span className="text-xs text-slate-500">{item.reportReady ? 'Report saved' : 'Feedback not prepared yet'}</span></div>
          <h2 className="mt-3 text-xl font-semibold">{item.title ?? topics[item.topic]}</h2>
          <p className="mt-2 text-sm text-slate-600">CEFR {item.level} / {difficultyLabel(item.difficulty)} / {item.durationMinutes} min</p>
          <p className="mt-2 text-sm text-slate-500">Finished <time dateTime={item.finishedAt}>{new Date(item.finishedAt).toLocaleString()}</time></p>
          {!item.reportReady && <p className="mt-3 text-xs text-slate-500">Your full feedback will be prepared when you open it.</p>}
          <Link className="mt-5 inline-flex min-h-11 w-fit items-center justify-center rounded-xl bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/20" to={`/language-practice/sessions/${item.id}/complete`}>Open full feedback</Link>
        </li>)}</ul>}
      <nav className="mt-6 flex flex-wrap items-center gap-3" aria-label="History pages"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous</Button><span className="text-sm text-slate-600">Page {offset / 20 + 1}</span><Button variant="outline" disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffset(page.nextOffset); }}>Next</Button></nav>
    </>}
  </main>;
}
