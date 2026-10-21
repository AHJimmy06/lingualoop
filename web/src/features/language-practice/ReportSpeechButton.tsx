import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Square, Volume2 } from 'lucide-react';
import { authSession } from '../../auth-session';
import { releaseAudio, synthesisErrorMessage, validateSynthesisText, validateWavBlob, type SynthesisLanguage } from '../../practice-synthesis';
import { reportAudioPlayback } from './report-audio-playback';

/** Explicit, local Piper playback only. No synthesis runs while rendering a report. */
export function ReportSpeechButton({ text, language = 'en', label = 'Listen' }: {
  text: string;
  language?: SynthesisLanguage;
  label?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const activePlayback = useRef(false);
  const releasePlayback = useRef<(() => void) | null>(null);
  const invalid = validateSynthesisText(text) !== null;
  const actionLabel = loading ? 'Preparing audio…' : playing ? 'Stop audio' : label;

  const dispose = () => {
    releasePlayback.current?.();
    releasePlayback.current = null;
    const currentAudio = audio.current;
    if (currentAudio) {
      currentAudio.onended = null;
      currentAudio.onpause = null;
      currentAudio.onerror = null;
    }
    releaseAudio(currentAudio, objectUrl.current);
    audio.current = null;
    objectUrl.current = null;
  };

  useEffect(() => {
    setLoading(false);
    setPlaying(false);
    setError('');
    return () => {
      generation.current += 1;
      pending.current = false;
      activePlayback.current = false;
      dispose();
    };
  }, [text, language]);

  async function listen() {
    if (invalid || pending.current) return;
    if (activePlayback.current && audio.current) {
      audio.current.pause();
      activePlayback.current = false;
      setPlaying(false);
      return;
    }
    const requestGeneration = ++generation.current;
    const isCurrent = () => generation.current === requestGeneration;
    releasePlayback.current = reportAudioPlayback.claim(() => {
      generation.current += 1;
      pending.current = false;
      activePlayback.current = false;
      if (audio.current) {
        audio.current.pause();
        audio.current.currentTime = 0;
      }
      releasePlayback.current?.();
      releasePlayback.current = null;
      setLoading(false);
      setPlaying(false);
    });
    pending.current = true;
    setLoading(true);
    setError('');
    try {
      if (!audio.current) {
        const result = await authSession.synthesize(language, text);
        if (!isCurrent()) return;
        if (!result.ok) {
          setError(result.error === 'unauthorized' ? 'Sign in again to listen to this text.' : synthesisErrorMessage(result.error));
          return;
        }
        const validAudio = await validateWavBlob(result.wav);
        if (!isCurrent()) return;
        if (!validAudio) throw new Error();
        objectUrl.current = URL.createObjectURL(result.wav);
        audio.current = new Audio(objectUrl.current);
      }
      // Rebind for every replay: the cached audio may belong to an older request generation.
      audio.current.onended = audio.current.onpause = () => {
        if (!isCurrent()) return;
        activePlayback.current = false;
        releasePlayback.current?.();
        releasePlayback.current = null;
        setPlaying(false);
      };
      audio.current.onerror = () => {
        if (!isCurrent()) return;
        activePlayback.current = false;
        setPlaying(false);
        setError('Audio could not be played. Please try again.');
        dispose();
      };
      audio.current.currentTime = 0;
      await audio.current.play();
      if (!isCurrent()) return;
      activePlayback.current = true;
      setPlaying(true);
    } catch {
      if (isCurrent()) {
        dispose();
        activePlayback.current = false;
        setPlaying(false);
        setError('Audio could not be played. Please try again.');
      }
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setLoading(false);
        if (!activePlayback.current) {
          releasePlayback.current?.();
          releasePlayback.current = null;
        }
      }
    }
  }

  return <span className="inline-flex max-w-full shrink-0 flex-col items-start gap-1">
    <button type="button" className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/5 text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" title={actionLabel} aria-label={actionLabel} disabled={invalid || loading} aria-busy={loading} aria-pressed={playing} onClick={() => void listen()}>
      {loading ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : playing ? <Square className="size-4" aria-hidden="true" /> : <Volume2 className="size-4" aria-hidden="true" />}
    </button>
    {invalid && <span className="text-xs text-muted-foreground">Audio requires non-empty text of up to 500 characters without control characters.</span>}
    {error && <span className="text-xs text-destructive" role="status" aria-live="polite">{error}</span>}
  </span>;
}
