import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { authSession } from '../../auth-session';
import { PracticeReportContent } from './PracticeReportContent';
import {
  LanguagePracticeClient,
  LanguagePracticeClientError,
  type LanguagePracticeClientErrorKind,
  type LanguagePracticeReport,
  type SessionDetail,
  type ReportLearningSupport,
} from './language-practice-client';

export function PracticeReportView() {
  const { sessionId = '' } = useParams<{ sessionId: string }>();
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const [report, setReport] = useState<LanguagePracticeReport | null>(null);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [turnsUnavailable, setTurnsUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorKind, setErrorKind] = useState<LanguagePracticeClientErrorKind | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [learningSupport, setLearningSupport] = useState<ReportLearningSupport | null>(null);
  const [supportLoading, setSupportLoading] = useState(false);
  const [supportError, setSupportError] = useState('');
  const supportVersion = useRef(0);
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);

  useEffect(() => {
    const updateConnection = () => setOffline(navigator.onLine === false);
    window.addEventListener('online', updateConnection);
    window.addEventListener('offline', updateConnection);
    return () => {
      window.removeEventListener('online', updateConnection);
      window.removeEventListener('offline', updateConnection);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const version = ++supportVersion.current;
    setLearningSupport(null);
    setSupportLoading(false);
    setSupportError('');
    setReport(null);
    setSession(null);
    setTurnsUnavailable(false);
    setLoading(true);
    setErrorKind(null);

    async function loadReport() {
      const [reportResult, sessionResult] = await Promise.allSettled([
        client.getOrCreateReport(sessionId),
        client.getSession(sessionId),
      ]);
      if (disposed) return;
      if (reportResult.status === 'fulfilled') setReport(reportResult.value);
      else setErrorKind(reportResult.reason instanceof LanguagePracticeClientError ? reportResult.reason.kind : 'unavailable');
      if (sessionResult.status === 'fulfilled') setSession(sessionResult.value);
      else setTurnsUnavailable(true);
      setLoading(false);
      if (reportResult.status === 'fulfilled') {
        setSupportLoading(true);
        try {
          const cached = await client.getCachedReportLearningSupport(sessionId);
          if (!disposed && supportVersion.current === version) setLearningSupport(cached);
        } catch {
          if (!disposed && supportVersion.current === version) setSupportError('The English version could not be loaded. Your original report is still available.');
        } finally {
          if (!disposed && supportVersion.current === version) setSupportLoading(false);
        }
      }
    }

    void loadReport();
    return () => { disposed = true; supportVersion.current++; };
  }, [attempt, client, sessionId]);

  async function prepareLearningSupport() {
    if (supportLoading || offline) return;
    const version = supportVersion.current;
    setSupportLoading(true);
    setSupportError('');
    try {
      const support = await client.prepareReportLearningSupport(sessionId);
      if (version === supportVersion.current) setLearningSupport(support);
    } catch {
      if (version === supportVersion.current) setSupportError('We could not prepare the English version. Your saved report has not changed. Please try again.');
    } finally {
      if (version === supportVersion.current) setSupportLoading(false);
    }
  }

  const canRetry = errorKind !== null && errorKind !== 'conflict' && errorKind !== 'not-found' && errorKind !== 'invalid-input';

  return (
    <main className="authenticated-page [overflow-wrap:anywhere]" aria-labelledby="report-title">
      <header className="mb-7 sm:mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">Practice complete</p>
        <h1 id="report-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">Your practice report</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Review saved evidence from your session and choose what to practice next.</p>
      </header>

      {loading && <section className="rounded-xl border bg-card p-5 text-sm text-muted-foreground shadow-sm sm:p-7" role="status" aria-live="polite">Preparing your report…</section>}

      {!loading && errorKind && <section className="grid gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm sm:p-7" role="alert">
        <h2 className="text-lg font-semibold">We could not load your report</h2>
        {offline && <p role="status">Your browser is offline. Reconnect, then choose Try again. Loading this page again does not require a new recording.</p>}
        {errorKind === 'forbidden' ? <p>Your role does not have permission to view practice reports.</p> : errorKind === 'conflict' ? <p className="leading-6">This session is still in progress. Return to your session and finish practicing before viewing its report.</p> :
          errorKind === 'not-found' ? <p className="leading-6">This practice session could not be found. Return to setup to start a new practice session.</p> :
            errorKind === 'invalid-input' ? <p className="leading-6">This session link is not valid. Return to setup to start a new practice session.</p> :
              <p className="leading-6">The session remains saved. You can try loading its report again.</p>}
        {errorKind === 'conflict' && <Link className="inline-flex min-h-10 w-fit items-center justify-center rounded-4xl border bg-input/30 px-4 text-sm font-medium outline-none hover:bg-input/50 focus-visible:ring-[3px] focus-visible:ring-ring/50" to={`/language-practice/sessions/${sessionId}`}>Return to session</Link>}
        {canRetry && <button type="button" className="inline-flex min-h-10 w-fit items-center justify-center rounded-4xl border bg-input/30 px-4 text-sm font-medium outline-none hover:bg-input/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50" disabled={loading || offline} onClick={() => setAttempt((current) => current + 1)}>Try again</button>}
      </section>}

      {!loading && report && <PracticeReportContent report={report} session={session} turnsUnavailable={turnsUnavailable}
        learningSupport={learningSupport} supportLoading={supportLoading} supportError={supportError}
        onLoadSupport={() => void prepareLearningSupport()} />}

      {!loading && !report && !errorKind && <p className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground" role="status">No report is available for this session.</p>}

      <nav className="mt-6" aria-label="Practice navigation">
        <Link className="inline-flex min-h-10 items-center justify-center rounded-4xl bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/80 focus-visible:ring-[3px] focus-visible:ring-ring/50" to="/language-practice">Return to practice setup</Link>
      </nav>
    </main>
  );
}
