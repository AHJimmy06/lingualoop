import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { selectSupportedAudioMimeType } from '../../practice-audio';
import { Button } from '../../components/ui/button';
import {
  formatRecordingTime,
  isRecorderShortcut,
  MAX_RECORDING_MS,
} from './practice-recorder-guards';
import { RecordingBuffer } from './react-recorder-state';
import { SpeakingEventState } from './react-live-audio';

type PracticeRecorderProps = {
  disabled?: boolean;
  actions?: ReactNode;
  onRecorded: (blob: Blob) => void;
  onBusyChange?: (busy: boolean) => void;
  onRecordingChange?: (recording: boolean) => void;
};

const failureMessage = 'Recording could not be completed. Please try again.';

export function PracticeRecorder({ disabled = false, onRecorded, onBusyChange, onRecordingChange, actions }: PracticeRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState('');
  const operationRef = useRef(0);
  const startingRef = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const disposedRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const bufferRef = useRef<RecordingBuffer | null>(null);
  const startedAtRef = useRef(0);
  const requestedDurationRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const onRecordingChangeRef = useRef(onRecordingChange);
  const speakingDetachRef = useRef<(() => void) | null>(null);
  onRecordingChangeRef.current = onRecordingChange;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const releaseTracks = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const cancel = useCallback(() => {
    operationRef.current += 1;
    clearTimer();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* Best-effort cancellation. */ }
    }
    speakingDetachRef.current?.();
    speakingDetachRef.current = null;
    releaseTracks();
    bufferRef.current = null;
    requestedDurationRef.current = null;
    startingRef.current = false;
    setStarting(false);
    setFinalizing(false);
    setRecording(false);
    onBusyChangeRef.current?.(false);
  }, [clearTimer, releaseTracks]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    clearTimer();
    requestedDurationRef.current = performance.now() - startedAtRef.current;
    setFinalizing(true);
    try {
      recorder.stop();
    } catch {
      setError(failureMessage);
      cancel();
      return;
    }
    // Keep the stream alive until final dataavailable and stop have completed.
  }, [cancel, clearTimer]);

  const start = useCallback(async () => {
    if (disabledRef.current || startingRef.current || recorderRef.current || disposedRef.current) return;
    startingRef.current = true;
    onBusyChangeRef.current?.(true);
    setError('');
    setElapsedMs(0);
    requestedDurationRef.current = null;
    setStarting(true);
    const operation = ++operationRef.current;
    let acquiredStream: MediaStream | null = null;
    try {
      const mimeType = selectSupportedAudioMimeType();
      if (!mimeType || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('unavailable');
      }
      acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (disposedRef.current || operation !== operationRef.current || disabledRef.current) {
        acquiredStream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = acquiredStream;
      const buffer = new RecordingBuffer();
      bufferRef.current = buffer;
      const recorder = new MediaRecorder(acquiredStream, { mimeType, audioBitsPerSecond: 128000 });
      recorderRef.current = recorder;
      const activity = new SpeakingEventState((isSpeaking) => onRecordingChangeRef.current?.(isSpeaking), 'start', ['stop', 'error']);
      speakingDetachRef.current = activity.attach(recorder);
      recorder.addEventListener('dataavailable', (event: BlobEvent) => {
        if (operation === operationRef.current && !disposedRef.current) { buffer.add(event.data); if (buffer.overflowed) { setError('Recording exceeds the 32 MiB safety limit. Please record a shorter response.'); cancel(); } }
      });
      recorder.addEventListener('stop', () => {
        if (operation !== operationRef.current || disposedRef.current) return;
        clearTimer();
        speakingDetachRef.current?.();
        speakingDetachRef.current = null;
        const duration = requestedDurationRef.current ?? performance.now() - startedAtRef.current;
        const blob = buffer.finish(duration, recorder.mimeType);
        bufferRef.current = null;
        recorderRef.current = null;
        setFinalizing(false);
        setRecording(false);
        onBusyChangeRef.current?.(false);
        setElapsedMs(Math.min(duration, MAX_RECORDING_MS));
        releaseTracks();
        if (blob) onRecordedRef.current(blob);
        else if (duration >= 250) setError(failureMessage);
      }, { once: true });
      recorder.addEventListener('error', () => {
        if (operation !== operationRef.current || disposedRef.current) return;
        setError(failureMessage);
        cancel();
      }, { once: true });
      recorder.start(1000);
      startedAtRef.current = performance.now();
      setRecording(true);
      timerRef.current = setInterval(() => {
        const elapsed = Math.min(performance.now() - startedAtRef.current, MAX_RECORDING_MS);
        setElapsedMs(elapsed);
        if (elapsed >= MAX_RECORDING_MS - 500) stop();
      }, 100);
    } catch {
      acquiredStream?.getTracks().forEach((track) => track.stop());
      if (!disposedRef.current && operation === operationRef.current) {
        setError('Microphone unavailable. Check permission and try again.');
        cancel();
      }
    } finally {
      if (!disposedRef.current && operation === operationRef.current) {
        startingRef.current = false;
        setStarting(false);
        if (!recorderRef.current) onBusyChangeRef.current?.(false);
      }
    }
  }, [cancel, disabled, onBusyChange, onRecorded, recording, starting, stop, clearTimer, releaseTracks]);

  useEffect(() => {
    if (!disabled) return;
    cancel();
  }, [cancel, disabled]);

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (!isRecorderShortcut(event, disabled) || starting) return;
      event.preventDefault();
      if (recording) stop();
      else void start();
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [disabled, recording, starting, start, stop]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      cancel();
    };
  }, [cancel]);

  useEffect(() => {
    onBusyChangeRef.current?.(starting || recording);
  }, [recording, starting]);

  return (
    <div className="grid w-full min-w-0 justify-items-center gap-2 text-center">
      <div className="flex w-full items-center justify-center gap-2">
      <div className="group relative w-full min-w-0 max-w-xs">
      <Button
        type="button"
        size="lg"
        className={`min-h-12 w-full max-w-xs touch-manipulation ${recording ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}`}
        disabled={disabled || starting || finalizing}
        onClick={recording ? stop : () => void start()}
        aria-describedby="recording-help"
        aria-label={finalizing ? 'Finishing recording' : recording ? 'Stop recording' : starting ? 'Starting microphone' : 'Start recording'}
      >
        <svg className="size-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>
        <span className="min-w-0 truncate">{finalizing ? 'Finishing recording...' : recording ? 'Stop recording' : starting ? 'Starting microphone...' : disabled ? 'Recording unavailable' : 'Start recording'}</span>
        {!starting && !finalizing && !disabled && <kbd aria-hidden="true" className="ml-1 hidden shrink-0 rounded border border-current/30 px-1.5 py-0.5 font-sans text-[10px] leading-none opacity-80 sm:inline-flex">Space</kbd>}

      </Button>
      <span id="recording-help" role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-64 max-w-[calc(100vw-3rem)] -translate-x-1/2 rounded-lg bg-slate-950 px-3 py-2 text-xs leading-5 text-white shadow-lg group-hover:block group-focus-within:block">{disabled
        ? 'Recording is unavailable for this session.'
        : recording ? 'Press Space or click to stop recording and send your response.'
        : 'When you are ready, record your response. Press Space when no other control is focused, or click the microphone to start.'}</span>
      </div>
      {actions}
      </div>
      {(starting || recording) && <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
        {recording ? `Recording… ${formatRecordingTime(elapsedMs)}` : 'Starting…'}
      </p>}
      {recording && <p className="max-w-md text-xs leading-5 text-muted-foreground">Take your time. Pauses will not end the recording. Use Stop recording to send your response. Technical maximum: 10 minutes.</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}
