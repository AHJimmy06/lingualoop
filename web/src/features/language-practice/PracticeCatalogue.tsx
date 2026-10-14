import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { Dialog } from '@base-ui/react/dialog';
import { X, ArrowUpRight } from 'lucide-react';
import { PracticeImage } from './PracticeImage';
import { difficultyLabel } from './practice-preferences';
import { LanguagePracticeClient, LanguagePracticeClientError, type TeacherPractice } from './language-practice-client';

export function PracticeDetails({ practice }: { practice: TeacherPractice }) {
  return <article className="min-w-0 rounded-xl border bg-card p-5 [overflow-wrap:anywhere]">
    <PracticeImage practice={practice} className="mb-4 h-40 w-full rounded-lg object-cover" />
    <h2 className="text-lg font-semibold">{practice.title}</h2>
    <p className="mt-1 text-sm text-muted-foreground">By {practice.teacherName}</p>
    <dl className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
      <div><dt>CEFR target</dt><dd>{practice.setup.level}</dd></div>
      <div><dt>Task difficulty</dt><dd>{difficultyLabel(practice.setup.difficulty)}</dd></div>
      <div><dt>Duration</dt><dd>{practice.setup.durationMinutes} minutes</dd></div>
    </dl>
    <h3 className="mt-4 text-sm font-semibold">Conversational requirements</h3>
    <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">{practice.parameters.map(item => <li key={item.id}>{item.requirement}</li>)}</ol>
  </article>;
}
export type ClaimPracticeStart = () => (() => void) | null;
export function PracticeCards({ practices, disabled = false, claimStart }: {
  practices: TeacherPractice[]; disabled?: boolean; claimStart?: ClaimPracticeStart;
}) {
  return <div className="mt-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">{practices.map(practice => <ChallengeCard key={practice.id} practice={practice} disabled={disabled} claimStart={claimStart} />)}</div>;
}
function ChallengeCard({ practice, disabled = false, claimStart }: {
  practice: TeacherPractice; disabled?: boolean; claimStart?: ClaimPracticeStart;
}) {
  const navigate = useNavigate();
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function start() {
    if (pending.current || disabled || !mounted.current) return;
    const release = claimStart ? claimStart() : () => {};
    if (!release) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const session = await client.createCustomSession({ practiceId: practice.id });
      if (mounted.current) navigate(`/language-practice/sessions/${session.id}`);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof LanguagePracticeClientError ? failure.message : 'The session was not confirmed. Try again.');
    } finally {
      // The shared claim belongs to the request, even if its card unmounts.
      release();
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <Dialog.Root open={open} onOpenChange={next => { if (!pending.current) { setOpen(next); setError(''); } }}>
    <Dialog.Trigger disabled={disabled} className="group min-w-0 overflow-hidden whitespace-normal rounded-xl border bg-card text-left outline-none transition-shadow motion-reduce:transition-none hover:border-primary/50 hover:shadow-md focus-visible:ring-4 focus-visible:ring-ring/50">
      <PracticeImage practice={practice} className="h-32 w-full object-cover sm:h-40" />
      <span className="grid min-w-0 grid-cols-1 gap-2 p-3 [overflow-wrap:anywhere] sm:p-4">
        <span className="flex min-w-0 items-start justify-between gap-2 font-semibold"><span className="min-w-0 flex-1">{practice.title}</span><ArrowUpRight className="size-4 shrink-0 text-primary" aria-hidden="true" /></span>
        <span className="min-w-0 text-xs text-muted-foreground">CEFR {practice.setup.level} · {practice.setup.durationMinutes} min · {difficultyLabel(practice.setup.difficulty)}</span>
        <span className="min-w-0 text-sm text-muted-foreground">By {practice.teacherName}</span>
      </span>
    </Dialog.Trigger>
    <Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" /><Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[90svh] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-xl sm:p-6">
      <div className="flex items-start justify-between gap-3"><Dialog.Title className="text-xl font-semibold">Ready for this challenge?</Dialog.Title><Dialog.Close disabled={busy} render={<Button size="icon" variant="ghost" />} aria-label="Close challenge"><X className="size-4" aria-hidden="true" /></Dialog.Close></div>
      <Dialog.Description className="mb-4 mt-2 text-sm leading-6 text-muted-foreground">Review the requirements before starting. Your default settings do not apply to this challenge.</Dialog.Description>
      <PracticeDetails practice={practice} />
      {error && <p className="mt-4 text-sm text-destructive" role="alert">{error}</p>}
      <Button className="mt-5 w-full" disabled={busy || disabled} onClick={() => void start()}>{busy ? 'Starting practice…' : 'Start teacher practice'}</Button>
      <Link className="mt-4 block text-center text-sm text-primary underline" to={`/language-practice/practices/${practice.id}`} onClick={event => { if (busy || disabled) event.preventDefault(); }}>Open challenge details</Link>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
export function PracticeCatalogue({ disabled = false, claimStart }: { disabled?: boolean; claimStart?: ClaimPracticeStart }) {
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const [practices, setPractices] = useState<TeacherPractice[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setPractices(null); setError('');
    void client.listPractices().then(value => { if (active) setPractices(value); }, failure => {
      if (active) setError(failure instanceof LanguagePracticeClientError ? failure.message : 'The teacher catalogue could not be loaded.');
    });
    return () => { active = false; };
  }, [client, attempt]);
  return <section className="mt-8 rounded-2xl border bg-muted/30 p-4 sm:p-6" aria-labelledby="catalogue-title">
    <h2 id="catalogue-title" className="text-lg font-semibold">Teacher challenges</h2>
    <p className="mt-2 text-sm text-muted-foreground">Dedicated challenges from all teachers. Review their fixed settings and requirements before you start.</p>
    {error ? <div className="mt-3" role="alert"><p>{error}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div> : practices === null ? <p className="mt-3" role="status">Loading teacher practices…</p> : practices.length === 0 ? <p className="mt-3 text-sm">No teacher practices are available yet. You can still start a default practice.</p> : <PracticeCards practices={practices} disabled={disabled} claimStart={claimStart} />}
  </section>;
}
export function CustomPracticeView() {
  const { practiceId = '' } = useParams<{ practiceId: string }>();
  const navigate = useNavigate();
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const [practice, setPractice] = useState<TeacherPractice | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  const startGeneration = useRef(0);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    startGeneration.current++;
    pending.current = false;
    setStarting(false);
    setPractice(null); setError(''); setLoading(true);
    void client.getPractice(practiceId).then(value => { if (active) setPractice(value); }, failure => {
      if (active) setError(failure instanceof LanguagePracticeClientError ? failure.message : 'This practice could not be loaded.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; startGeneration.current++; };
  }, [client, practiceId, attempt]);
  async function start() {
    if (!practice || practice.id !== practiceId || pending.current || loading) return;
    const generation = startGeneration.current;
    pending.current = true; setStarting(true); setError('');
    try {
      const session = await client.createCustomSession({ practiceId: practice.id });
      if (generation === startGeneration.current) navigate(`/language-practice/sessions/${session.id}`);
    } catch (failure) {
      if (generation === startGeneration.current) setError(failure instanceof LanguagePracticeClientError ? failure.message : 'The session was not confirmed. Try again.');
    } finally {
      if (generation === startGeneration.current) { pending.current = false; setStarting(false); }
    }
  }
  return <main className="authenticated-page [overflow-wrap:anywhere]">
    <h1 className="mb-4 text-3xl font-semibold">Teacher-guided practice</h1>
    <p className="mb-4 max-w-prose text-sm text-muted-foreground">These settings and requirements are fixed by your teacher.</p>
    {loading && <p role="status">Loading practice…</p>}
    {error && <div className="my-4" role="alert"><p>{error}</p>{!practice && <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button>}</div>}
    {!loading && practice && <>
      <div className="min-w-0 [&_h2]:max-w-prose [&_p]:max-w-prose [&_ol]:max-w-prose"><PracticeDetails practice={practice} /></div>
      <Button className="mt-4" disabled={starting} onClick={() => void start()}>{starting ? 'Starting practice…' : 'Start teacher practice'}</Button>
    </>}
    <nav className="mt-6"><Link className="text-sm text-primary underline" to="/language-practice">Return to catalogue and default practice</Link></nav>
  </main>;
}
