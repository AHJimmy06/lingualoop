import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Volume2 } from 'lucide-react';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { Bubble, BubbleContent } from '../../components/ui/bubble';
import { Message, MessageContent, MessageGroup, MessageHeader } from '../../components/ui/message';
import {
  LanguagePracticeClient,
  LanguagePracticeClientError,
  type LanguagePracticeTurnResponse,
  type SessionDetail,
} from './language-practice-client';
import { anchorTimer, projectRemainingMs, type TimerAnchor } from './live-session-state';
import { LiveTurnController } from './react-live-turn';
import { ResponseAudioUrls } from './react-live-audio';
import { PracticeRecorder } from './PracticeRecorder';
import { PracticeScene } from './PracticeScene';

const topicLabels: Record<string, string> = {
  travel: 'Travel', work: 'Work', studies: 'Studies', 'everyday-conversation': 'Everyday conversation',
};

export function LivePracticeView() {
  const { sessionId = '' } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const turnController = useMemo(() => new LiveTurnController(), [sessionId]);
  const audioController = useRef(new ResponseAudioUrls());
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [turnStatus, setTurnStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [recorderBusy, setRecorderBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState('');
  const [clock, setClock] = useState({ now: 0, anchor: null as TimerAnchor | null });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const audioElement = useRef<HTMLAudioElement>(null);
  const sessionRef = useRef(session);
  const controllerRef = useRef(turnController);
  const requestInFlight = useRef<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const expiryCheckRequested = useRef(false);
  const navigatingToCompletion = useRef(false);
  const finishInFlight = useRef(false);
  sessionRef.current = session;
  controllerRef.current = turnController;

  const remainingMs = clock.anchor ? projectRemainingMs(clock.anchor, clock.now) : 0;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const active = session?.status === 'ACTIVE' && remainingMs > 0;

  const navigateToCompletion = useCallback((id: string) => {
    if (navigatingToCompletion.current) return;
    navigatingToCompletion.current = true;
    navigate(`/language-practice/sessions/${id}/complete`, { replace: true });
  }, [navigate]);

  const loadSession = useCallback(async () => {
    if (requestInFlight.current === sessionId || controllerRef.current.pending) return;
    requestInFlight.current = sessionId;
    setRefreshing(true);
    if (!sessionRef.current) setLoading(true);
    setError('');
    const requestedSessionId = sessionId;
    try {
      const snapshot = await client.getSession(requestedSessionId);
      if (sessionIdRef.current !== requestedSessionId) return;
      setSession(snapshot);
      sessionRef.current = snapshot;
      const now = performance.now();
      setClock({ now, anchor: anchorTimer(snapshot.remainingMs, now) });
      expiryCheckRequested.current = snapshot.status !== 'ACTIVE' || snapshot.remainingMs === 0;
      if (snapshot.status === 'EXPIRED' || snapshot.status === 'COMPLETED') navigateToCompletion(requestedSessionId);
    } catch (cause) {
      if (sessionIdRef.current === requestedSessionId) {
        setError(cause instanceof LanguagePracticeClientError && cause.kind === 'not-found'
          ? 'This practice session could not be found.'
          : 'The session could not be refreshed. Your saved session remains unchanged.');
      }
    } finally {
      if (requestInFlight.current === requestedSessionId) requestInFlight.current = null;
      if (sessionIdRef.current === requestedSessionId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [client, navigateToCompletion, sessionId]);

  useEffect(() => {
    setSession(null);
    sessionRef.current = null;
    setClock({ now: performance.now(), anchor: null });
    setError('');
    setTurnStatus('');
    setPending(false);
    setSubmitting(false);
    setFinishing(false);
    setRecorderBusy(false);
    finishInFlight.current = false;
    setAudioUrl(null);
    audioController.current.clear();
    setPlaybackError('');
    setLoading(true);
    expiryCheckRequested.current = false;
    navigatingToCompletion.current = false;
    void loadSession();
    return () => {
      audioController.current.clear();
    };
  }, [loadSession]);

  useEffect(() => {
    const updateClock = () => {
      const now = performance.now();
      setClock((current) => ({ ...current, now }));
    };
    const refreshOnFocus = () => { void loadSession(); };
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void loadSession(); };
    const timer = window.setInterval(updateClock, 250);
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadSession]);

  useEffect(() => {
    if (session?.status === 'ACTIVE' && remainingMs === 0 && !expiryCheckRequested.current && !turnController.pending) {
      expiryCheckRequested.current = true;
      void loadSession();
    }
  }, [loadSession, remainingMs, session?.status, turnController]);

  useEffect(() => {
    if (!audioUrl) return;
    let activeEffect = true;
    void audioController.current.autoplay(async () => {
      if (!audioElement.current) throw new Error('Audio element is not ready');
      await audioElement.current.play();
    }).then((played) => {
      if (activeEffect && !played && audioController.current.manualReplayRequired) {
        setPlaybackError('Automatic playback did not start. Tap Replay response to listen.');
      }
    });
    return () => { activeEffect = false; };
  }, [audioUrl]);

  const checkSameTurn = async (automatic: boolean) => {
    const controller = turnController;
    const requestedSessionId = sessionId;
    if (!controller.pending || controller.submitting) return;
    setSubmitting(true);
    setTurnStatus(automatic ? 'Sending your recorded turn…' : 'Checking the same recorded turn…');
    setError('');
    const result = await controller.check(requestedSessionId, (id, blob, clientTurnId) => client.submitTurn(id, blob, clientTurnId));
    if (controllerRef.current !== controller) return;
    setSubmitting(false);
    setPending(controller.pending !== null);
    if (result.kind === 'processing') {
      const response = result.response as LanguagePracticeTurnResponse;
      setSession(response.session);
      sessionRef.current = response.session;
      const now = performance.now();
      setClock({ now, anchor: anchorTimer(response.session.remainingMs, now) });
      expiryCheckRequested.current = response.session.status !== 'ACTIVE' || response.session.remainingMs === 0;
      setTurnStatus('Your response is still on its way. Check again shortly.');
    } else if (result.kind === 'completed' || result.kind === 'failed') {
      const response = result.response as LanguagePracticeTurnResponse;
      setSession(response.session);
      sessionRef.current = response.session;
      const now = performance.now();
      setClock({ now, anchor: anchorTimer(response.session.remainingMs, now) });
      expiryCheckRequested.current = response.session.status !== 'ACTIVE' || response.session.remainingMs === 0;
      if (result.kind === 'failed') {
        setTurnStatus('This response could not be completed. Please record a new response if time remains.');
        audioController.current.clear();
        setAudioUrl(null);
      } else {
        setTurnStatus('');
        const nextUrl = audioController.current.replace(response);
        setAudioUrl(nextUrl);
        setPlaybackError('');
      }
      if (response.session.status === 'EXPIRED' || response.session.status === 'COMPLETED') navigateToCompletion(requestedSessionId);
    } else if (result.kind === 'uncertain') {
      setTurnStatus('We could not confirm your response yet. Check again before recording another.');
      if (result.cause instanceof LanguagePracticeClientError && result.cause.kind === 'unauthenticated') {
        setError('Please sign in, then check again to retrieve your response.');
      }
    }
  };

  const onRecorded = (blob: Blob) => {
    if (sessionIdRef.current !== sessionId) return;
    const turn = turnController.record(blob, active);
    if (!turn) return;
    setPending(true);
    setTurnStatus('Sending your recorded turn…');
    void checkSameTurn(true);
  };

  const replayAudio = async () => {
    setPlaybackError('');
    const played = await audioController.current.replay(async () => {
      if (!audioElement.current) throw new Error('Audio element is not ready');
      await audioElement.current.play();
    });
    if (!played) setPlaybackError('Playback did not start. Tap Replay response to try again.');
  };

  const onRecorderBusyChange = useCallback((busy: boolean) => setRecorderBusy(busy), []);

  const finishPractice = async () => {
    if (finishInFlight.current || !active || turnController.pending || submitting || recorderBusy || sessionIdRef.current !== sessionId) return;
    finishInFlight.current = true;
    setFinishing(true);
    setError('');
    const requestedSessionId = sessionId;
    try {
      const result = await client.finishSession(requestedSessionId);
      if (sessionIdRef.current !== requestedSessionId) return;
      if (result.id === requestedSessionId && (result.status === 'COMPLETED' || result.status === 'EXPIRED')) {
        navigateToCompletion(requestedSessionId);
      }
    } catch {
      if (sessionIdRef.current === requestedSessionId) {
        setError('We could not finish your practice just now. Try again, or refresh your session.');
      }
    } finally {
      if (sessionIdRef.current === requestedSessionId) {
        finishInFlight.current = false;
        setFinishing(false);
      }
    }
  };

  return (
    <main className="mx-auto min-h-svh w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10" aria-labelledby="session-title">
      <header className="mb-6 flex items-start justify-between gap-3 sm:mb-8">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary">Timed English practice</p>
          <h1 id="session-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">Your conversation</h1>
        </div>
        {session && <div className="shrink-0 rounded-full bg-secondary px-3 py-1.5 text-lg font-semibold tabular-nums" role="timer" aria-label="Time remaining">
          {Math.floor(remainingSeconds / 60)}:{String(remainingSeconds % 60).padStart(2, '0')}
        </div>}
      </header>

      {loading && <p className="py-8 text-sm text-muted-foreground" role="status">Loading your practice session…</p>}
      {!loading && !session && <section className="grid gap-3 rounded-xl border p-5" role="alert">
        <h2 className="text-lg font-semibold">Practice session unavailable</h2>
        <p className="text-sm text-muted-foreground">{error || 'This practice session could not be loaded.'}</p>
        <Link className="w-fit text-sm font-medium text-primary underline underline-offset-4" to="/language-practice">Return to setup</Link>
      </section>}
      {session && <>
        <section className="mb-6 flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Session details">
          <p><strong>Level</strong> <span className="text-muted-foreground">{session.level}</span></p>
          <p><strong>Topic</strong> <span className="text-muted-foreground">{topicLabels[session.topic] || session.topic}</span></p>
          <p><strong>Duration</strong> <span className="text-muted-foreground">{session.durationMinutes} minutes</span></p>
        </section>

        <PracticeScene topic={session.topic} />

        <section aria-labelledby="conversation-title" className="mb-8">
          <h2 id="conversation-title" className="mb-4 text-lg font-semibold">Conversation so far</h2>
          {session.turns.length === 0
            ? <p className="py-3 text-sm text-muted-foreground">Your completed conversation turns will appear here.</p>
            : <ol className="grid gap-5">
              {session.turns.map((turn, index) => <li key={turn.sequence} className="min-w-0">
                <p className="mb-3 text-xs font-medium text-muted-foreground">Turn {turn.sequence}</p>
                <MessageGroup className="gap-3">
                  <Message align="end">
                    <MessageContent><MessageHeader>You</MessageHeader><Bubble variant="tinted"><BubbleContent>{turn.transcript || 'No transcript was saved for this turn.'}</BubbleContent></Bubble></MessageContent>
                  </Message>
                  <Message align="start">
                    <MessageContent><MessageHeader>Conversation partner</MessageHeader><Bubble variant="secondary"><BubbleContent>{turn.assistantResponse || 'No response text was saved for this turn.'}</BubbleContent></Bubble>{index === session.turns.length - 1 && audioUrl && <Button type="button" variant="ghost" size="icon" className="mt-1" title="Replay response" onClick={() => void replayAudio()} aria-label="Replay response"><Volume2 aria-hidden="true" /></Button>}</MessageContent>
                  </Message>
                </MessageGroup>
              </li>)}
            </ol>}
        </section>

        <section className="grid justify-items-center gap-4 border-t py-6" aria-label="Voice turn controls">
          {turnController.pending
            ? <p className="max-w-md text-center text-sm leading-6 text-muted-foreground">Your response is being prepared. You can check again shortly; no new recording is needed.</p>
            : <p className="max-w-md text-center text-sm leading-6 text-muted-foreground">{active
              ? 'When you are ready, record your response.'
              : 'This session has expired. You can no longer record a new turn.'}</p>}
          {!turnController.pending && <PracticeRecorder key={sessionId} disabled={!active} onRecorded={onRecorded} onBusyChange={onRecorderBusyChange} />}
          {turnController.pending && <Button type="button" variant="outline" disabled={submitting} onClick={() => void checkSameTurn(false)}>
            {submitting ? 'Checking…' : 'Check for response'}
          </Button>}
          {turnStatus && <p className="max-w-lg text-center text-sm text-muted-foreground" role="status">{turnStatus}</p>}
          {turnController.pending && remainingMs === 0 && <p className="max-w-lg text-center text-sm text-muted-foreground" role="status">Time is up, but your response is still being prepared. Check again when ready.</p>}
          {audioUrl && <>
            <audio ref={audioElement} src={audioUrl} preload="none" hidden />
            {playbackError && <p className="text-center text-sm text-muted-foreground" role="status">{playbackError}</p>}
          </>}
        </section>
        {error && <p className="mb-4 text-sm text-destructive" role="alert">{error}</p>}
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="outline" disabled={refreshing || turnController.pending !== null} onClick={() => void loadSession()}>
            {refreshing ? 'Refreshing…' : 'Refresh session'}
          </Button>
          <Button type="button" disabled={!active || turnController.pending !== null || submitting || finishing || recorderBusy} onClick={() => void finishPractice()}>
            {finishing ? 'Finishing…' : 'Finish practice'}
          </Button>
        </div>
      </>}
    </main>
  );
}
