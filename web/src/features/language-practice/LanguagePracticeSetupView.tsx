import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { LanguagePracticeClient, type PracticeSetup } from './language-practice-client';
import { fetchPracticeOptions, type PracticeOptions } from './practice-options';
import { getPracticeScene } from './PracticeScene';

export function isPracticeSetupValid(
  options: PracticeOptions | null,
  level: string,
  topic: string,
  duration: number | null,
): boolean {
  return Boolean(options && options.levels.includes(level) &&
    options.topics.some((item) => item.code === topic) &&
    options.durationsMinutes.includes(duration ?? 0));
}

export function LanguagePracticeSetupView() {
  const navigate = useNavigate();
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const [options, setOptions] = useState<PracticeOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [level, setLevel] = useState('');
  const [topic, setTopic] = useState('');
  const [duration, setDuration] = useState<number | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState('');

  const canStart = isPracticeSetupValid(options, level, topic, duration);

  async function loadOptions() {
    setLoading(true);
    setError('');
    try {
      const loaded = await fetchPracticeOptions(authSession);
      setOptions(loaded);
      setLevel((current) => current || loaded.levels[0] || '');
      setTopic((current) => current || loaded.topics[0]?.code || '');
      setDuration((current) => current ?? loaded.durationsMinutes[0] ?? null);
    } catch {
      setOptions(null);
      setError('Practice options could not be loaded. Your setup has not been saved.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadOptions(); }, []);

  async function startPractice() {
    if (creating || !options || !canStart || duration === null) return;
    const setup: PracticeSetup = {
      level: level as PracticeSetup['level'],
      topic: topic as PracticeSetup['topic'],
      durationMinutes: duration as PracticeSetup['durationMinutes'],
    };
    setCreating(true);
    setCreationError('');
    try {
      const created = await client.createSession(setup);
      navigate(`/language-practice/sessions/${created.id}`);
    } catch {
      setCreationError('Practice could not be started. No session was confirmed; please try again.');
    } finally {
      setCreating(false);
    }
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    const confirmed = await authSession.logout();
    authSession.clearLocal();
    setOptions(null);
    setLevel('');
    setTopic('');
    setDuration(null);
    navigate(confirmed ? '/login' : '/login?logout=unconfirmed', { replace: true });
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-7 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">Your learning space</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Language Practice</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Choose the level, topic, and time for a guided English conversation.</p>
        </div>
        <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={loggingOut} onClick={() => void logout()}>
          {loggingOut ? 'Signing out…' : 'Log out'}
        </Button>
      </header>

      <section className="rounded-xl border bg-card p-5 shadow-sm sm:p-7" aria-labelledby="setup-title">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary" aria-hidden="true">1</span>
          <div>
            <h2 id="setup-title" className="text-lg font-semibold">Set up your practice</h2>
            <p className="mt-1 text-sm text-muted-foreground">These options come from the LinguaLoop practice service.</p>
          </div>
        </div>

        {loading && <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground" role="status">Loading available practice options…</p>}
        {!loading && error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm" role="alert">
          <p>{error}</p>
          <Button type="button" variant="outline" className="mt-4" onClick={() => void loadOptions()}>Try again</Button>
        </div>}
        {!loading && !error && options && <div className="grid gap-5">
          <section className="relative isolate flex min-h-64 items-end overflow-hidden rounded-xl border bg-muted sm:min-h-80" aria-label={`${options.topics.find((item) => item.code === topic)?.label ?? getPracticeScene(topic).label} practice preview`}>
            <img className="absolute inset-0 -z-10 h-full w-full object-cover" src={getPracticeScene(topic).image} alt="" aria-hidden="true" />
            <div className="w-full bg-gradient-to-t from-black/75 via-black/25 to-transparent px-5 pb-5 pt-16 sm:px-7 sm:pb-7">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/80">Practice scene</p>
              <h3 className="mt-1 text-2xl font-semibold text-white drop-shadow sm:text-3xl">{options.topics.find((item) => item.code === topic)?.label ?? getPracticeScene(topic).label}</h3>
            </div>
          </section>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="grid gap-2 text-sm font-medium" htmlFor="practice-topic">Conversation topic
              <select id="practice-topic" className="h-11 w-full rounded-md border bg-background px-3 font-normal" value={topic} onChange={(event) => setTopic(event.target.value)}>
                {options.topics.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-medium" htmlFor="practice-level">English level
              <select id="practice-level" className="h-11 w-full rounded-md border bg-background px-3 font-normal" value={level} onChange={(event) => setLevel(event.target.value)}>
                {options.levels.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-medium" htmlFor="practice-duration">Practice duration
              <select id="practice-duration" className="h-11 w-full rounded-md border bg-background px-3 font-normal" value={duration ?? ''} onChange={(event) => setDuration(Number(event.target.value) || null)}>
                {options.durationsMinutes.map((item) => <option key={item} value={item}>{item} minutes</option>)}
              </select>
            </label>
          </div>
          {creationError && <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">{creationError}</p>}
          <Button type="button" size="lg" className="mt-1 w-full sm:w-auto sm:justify-self-start" disabled={creating || !canStart} onClick={() => void startPractice()}>
            {creating ? 'Starting practice…' : 'Start practice'}
          </Button>
        </div>}
      </section>
    </main>
  );
}
