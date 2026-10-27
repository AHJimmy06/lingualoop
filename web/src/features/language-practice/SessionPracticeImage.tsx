import { useEffect, useMemo, useState } from 'react';
import { authSession } from '../../auth-session';
import { LanguagePracticeClient } from './language-practice-client';
import { PracticeScene } from './PracticeScene';

type ImageState = { id: string; status: 'loading' | 'ready' | 'absent' | 'error'; url?: string };

/** Resolve from durable session identity, including direct navigation and reloads. */
export function SessionPracticeImage({ sessionId, topic, learnerState, partnerState }: {
  sessionId: string; topic: string;
  learnerState?: 'idle' | 'speaking' | 'listening';
  partnerState?: 'idle' | 'speaking' | 'listening';
}) {
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const [image, setImage] = useState<ImageState>({ id: sessionId, status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let ownedUrl: string | undefined;
    setImage({ id: sessionId, status: 'loading' });
    void client.getSessionImage(sessionId).then(blob => {
      if (!active) return;
      if (!blob) { setImage({ id: sessionId, status: 'absent' }); return; }
      ownedUrl = URL.createObjectURL(blob);
      setImage({ id: sessionId, status: 'ready', url: ownedUrl });
    }).catch(() => { if (active) setImage({ id: sessionId, status: 'error' }); });
    return () => { active = false; if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [client, sessionId, attempt]);
  const current = image.id === sessionId ? image : { status: 'loading' as const };
  if (current.status === 'absent') return <PracticeScene topic={topic} learnerState={learnerState} partnerState={partnerState} />;
  return <section className="mb-8 flex min-h-52 min-w-0 flex-col rounded-2xl border bg-card p-3" aria-label="Activity image">
    {current.status === 'ready' && 'url' in current ? <>
      <a href={current.url} target="_blank" rel="noopener noreferrer" className="min-h-0 flex-1" aria-label="Open full activity image">
        <img src={current.url} alt="Activity material provided by your teacher" className="h-full max-h-[70svh] w-full object-contain" onError={() => setImage({ id: sessionId, status: 'error' })} />
      </a>
      <p className="mt-2 text-sm text-muted-foreground">Select the image to open it at full size.</p>
    </> : current.status === 'error' ? <div role="alert">
      <p>The activity image could not be loaded. No substitute image is shown.</p>
      <button type="button" className="mt-2 underline" onClick={() => setAttempt(value => value + 1)}>Retry image</button>
    </div> : <p role="status">Loading activity image…</p>}
  </section>;
}
