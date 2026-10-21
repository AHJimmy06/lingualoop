import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, LogOut, X } from 'lucide-react';
import { Dialog } from '@base-ui/react/dialog';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { LanguagePracticeClient, LANGUAGE_PRACTICE_DIFFICULTIES, type PracticeDifficulty, type PracticeSetup } from './language-practice-client';
import { fetchPracticeOptions, type PracticeOptions } from './practice-options';
import { getPracticeScene } from './PracticeScene';
import { PracticeCatalogue, type ClaimPracticeStart } from './PracticeCatalogue';
import { PracticeSettingsDialog } from './PracticeSettingsDialog';
import { difficultyLabel, readPreferences, savePreferences, type PracticePreferences } from './practice-preferences';

export function isPracticeSetupValid(options: PracticeOptions | null, level: string, topic: string, duration: number | null): boolean {
  return Boolean(options && options.levels.includes(level) && options.topics.some(item => item.code === topic) && options.durationsMinutes.includes(duration ?? 0));
}

export function DefaultTopicTiles({ options, topic, difficulty, level, onSelect, disabled = false }: {
  options: PracticeOptions; topic: string; difficulty: PracticeDifficulty; level: string;
  onSelect: (topic: string, difficulty: PracticeDifficulty) => void; disabled?: boolean;
}) {
  return <>
    {options.topics.flatMap(item => LANGUAGE_PRACTICE_DIFFICULTIES.map(variant => <button key={`${item.code}:${variant}`} type="button" disabled={disabled} aria-pressed={topic === item.code && difficulty === variant} onClick={() => onSelect(item.code, variant)}
      className={`group relative isolate min-h-44 overflow-hidden rounded-xl border text-left outline-none transition-shadow motion-reduce:transition-none hover:shadow-lg focus-visible:ring-4 focus-visible:ring-ring/50 disabled:opacity-60 sm:min-h-52 ${topic === item.code && difficulty === variant ? 'ring-2 ring-primary ring-offset-2' : ''}`}>
      <img src={getPracticeScene(item.code).image} alt="" aria-hidden="true" className="absolute inset-0 -z-10 h-full w-full object-cover" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
      {topic === item.code && difficulty === variant && <span className="absolute right-3 top-3 rounded-full bg-primary p-1.5 text-primary-foreground"><Check className="size-4" aria-hidden="true" /></span>}
      <span className="absolute inset-x-0 bottom-0 grid gap-1 p-4 text-base font-semibold text-white sm:text-lg"><span>{item.label}</span><span className="text-sm font-medium">{difficultyLabel(variant)} · CEFR {level}</span></span>
    </button>))}
  </>;
}

export function LanguagePracticeSetupView() {
  const navigate = useNavigate();
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const ownerId = authSession.profile?.ownerId ?? '';
  const [preferences, setPreferences] = useState(() => readPreferences(ownerId));
  const [options, setOptions] = useState<PracticeOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [topic, setTopic] = useState('');
  const [practiceDetailsOpen, setPracticeDetailsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const claimStart: ClaimPracticeStart = () => {
    if (pending.current || loggingOut || !mounted.current) return null;
    pending.current = true;
    setStarting(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pending.current = false;
      if (mounted.current) setStarting(false);
    };
  };
  const [creationError, setCreationError] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const canStart = isPracticeSetupValid(options, preferences.level, topic, preferences.durationMinutes);
  async function loadOptions() {
    setLoading(true); setError('');
    try {
      const loaded = await fetchPracticeOptions(authSession);
      setOptions(loaded);
      setTopic(current => loaded.topics.some(item => item.code === current) ? current : loaded.topics[0]?.code ?? '');
      setPreferences(current => ({
        ...current,
        level: (loaded.levels.includes(current.level) ? current.level : loaded.levels[0]) as PracticeSetup['level'],
        durationMinutes: (loaded.durationsMinutes.includes(current.durationMinutes) ? current.durationMinutes : loaded.durationsMinutes[0]) as PracticeSetup['durationMinutes'],
      }));
    } catch { setOptions(null); setError('Practice options could not be loaded. Your setup has not been saved.'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void loadOptions();
    return () => { mounted.current = false; };
  }, []);
  function changeSettings(value: PracticePreferences) {
    if (pending.current || !options || !options.levels.includes(value.level) || !options.durationsMinutes.includes(value.durationMinutes) || !LANGUAGE_PRACTICE_DIFFICULTIES.includes(value.difficulty)) return;
    setPreferences(value);
    setSettingsMessage(savePreferences(ownerId, value) ? 'Default practice settings saved.' : 'Settings apply for this visit. Browser storage is unavailable; they may not be remembered.');
  }
  async function startPractice() {
    if (!canStart) return;
    const release = claimStart();
    if (!release) return;
    setCreating(true); setCreationError('');
    try {
      const created = await client.createSession({ ...preferences, topic: topic as PracticeSetup['topic'] });
      if (mounted.current) navigate(`/language-practice/sessions/${created.id}`);
    } catch {
      if (mounted.current) setCreationError('Practice could not be started. No session was confirmed; please try again.');
    } finally {
      release();
      if (mounted.current) setCreating(false);
    }
  }
  async function logout() {
    if (loggingOut || pending.current) return;
    setLoggingOut(true);
    const confirmed = await authSession.logout();
    authSession.clearLocal();
    navigate(confirmed ? '/login' : '/login?logout=unconfirmed', { replace: true });
  }
  return <main className="authenticated-page [overflow-wrap:anywhere]">
    <header className="mb-8 flex flex-wrap items-end justify-between gap-5 border-b border-slate-200/80 pb-6 sm:mb-9 sm:pb-7">
      <div className="min-w-0 break-words"><p className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-teal-800"><span className="size-2 rounded-full bg-teal-500 shadow-[0_0_0_4px_rgba(20,184,166,0.12)]" aria-hidden="true" />Your learning space</p><h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Language Practice</h1><p className="mt-2 text-sm leading-6 text-slate-600 sm:text-base">Choose a conversation. Build confidence one turn at a time.</p></div>
      <div className="flex flex-wrap items-center gap-2"><PracticeSettingsDialog options={options} value={preferences} onSave={changeSettings} disabled={starting || loggingOut} /><Button variant="outline" disabled={loggingOut || starting} onClick={() => void logout()}><LogOut className="size-4" aria-hidden="true" />{loggingOut ? 'Signing out…' : 'Log out'}</Button></div>
    </header>
    <section className="rounded-2xl border border-white/80 bg-white/90 p-4 shadow-lg shadow-slate-900/5 backdrop-blur sm:p-6" aria-labelledby="setup-title">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 id="setup-title" className="text-xl font-semibold tracking-tight text-slate-900">Practices</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">Choose a conversation or a teacher-created practice. Each activity shows its settings and requirements before you start.</p></div><p className="rounded-full bg-teal-50 px-3 py-1.5 text-sm font-semibold text-teal-800 ring-1 ring-inset ring-teal-700/10">CEFR {preferences.level} · {preferences.durationMinutes} minutes</p></div>
      {settingsMessage && <p className="mb-4 text-sm text-muted-foreground" role="status">{settingsMessage}</p>}
      {loading && <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground" role="status">Loading available practice options…</p>}
      {!loading && error && <div role="alert"><p>{error}</p><Button className="mt-3" variant="outline" onClick={() => void loadOptions()}>Try again</Button></div>}
      <div role="group" className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="All available practices">
        {!loading && !error && options && <DefaultTopicTiles options={options} topic={topic} difficulty={preferences.difficulty} level={preferences.level} onSelect={(value, difficulty) => {
          if (pending.current || loggingOut) return;
          setTopic(value);
          changeSettings({ ...preferences, difficulty });
          setCreationError('');
          setPracticeDetailsOpen(true);
        }} disabled={starting || loggingOut} />}
        <PracticeCatalogue disabled={starting || loggingOut} claimStart={claimStart} />
      </div>
      {!loading && !error && options && <>
        <Dialog.Root open={practiceDetailsOpen} onOpenChange={next => { if (!pending.current) { setPracticeDetailsOpen(next); if (!next) setCreationError(''); } }}>
          <Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
            <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[90svh] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-xl sm:p-6">
              <div className="flex items-start justify-between gap-3"><div><Dialog.Title className="text-xl font-semibold">Practice details</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">Review this activity before starting your conversation.</Dialog.Description></div><Dialog.Close disabled={creating} render={<Button size="icon" variant="ghost" />} aria-label="Close practice details"><X className="size-4" aria-hidden="true" /></Dialog.Close></div>
              <div className="mt-4 overflow-hidden rounded-xl border bg-background">
                <img src={getPracticeScene(topic).image} alt="" className="h-40 w-full object-cover" />
                <div className="p-4"><h3 className="font-semibold">{options.topics.find(item => item.code === topic)?.label}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{difficultyLabel(preferences.difficulty)} · CEFR {preferences.level} · {preferences.durationMinutes} minutes</p>
                  <h4 className="mt-4 text-sm font-semibold">Conversation activity</h4><p className="mt-1 text-sm leading-6 text-muted-foreground">Practice a conversation about {options.topics.find(item => item.code === topic)?.label?.toLowerCase()} at the selected task difficulty.</p>
                </div>
              </div>
              {creationError && <p className="mt-3 text-sm text-destructive" role="alert">{creationError}</p>}
              <Button className="mt-4 w-full" size="lg" disabled={creating || loggingOut || !canStart} onClick={() => void startPractice()}>{creating ? 'Starting practice…' : 'Start practice'}</Button>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </>}
    </section>
  </main>;
}
