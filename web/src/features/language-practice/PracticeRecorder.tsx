import { useCallback, useEffect, useRef, useState } from 'react';
import { selectSupportedAudioMimeType } from '../../practice-audio';
import { Button } from '../../components/ui/button';
import {
  formatRecordingTime,
  isRecorderShortcut,
  MAX_RECORDING_MS,
} from './practice-recorder-guards';
import { RecordingBuffer } from './react-recorder-state';
import { SpeakingEventState } from './react-live-audio';
import { monitorRecordingSilence, type RecordingSilenceMonitor } from './recording-silence';

type PracticeRecorderProps = {
  disabled?: boolean;
  onRecorded: (blob: Blob) => void;
  onBusyChange?: (busy: boolean) => void;
  onRecordingChange?: (recording: boolean) => void;
};

const failureMessage = 'Recording could not be completed. Please try again.';

export function PracticeRecorder({ disabled = false, onRecorded, onBusyChange, onRecordingChange }: PracticeRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState('');
  const [automaticStop, setAutomaticStop] = useState(false);
  const silenceMonitorRef = useRef<RecordingSilenceMonitor | null>(null);
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
  const onRecordingChangeRef = useRef(onRecordingChange);
  const speakingDetachRef = useRef<(() => void) | null>(null);
  onRecordingChangeRef.current = onRecordingChange;

  const stopSilenceMonitor = useCallback(() => {
    silenceMonitorRef.current?.stop();
    silenceMonitorRef.current = null;
  }, []);

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
    stopSilenceMonitor();
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
    setRecording(false);
    onBusyChange?.(false);
  }, [clearTimer, onBusyChange, releaseTracks, stopSilenceMonitor]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    clearTimer();
    stopSilenceMonitor();
    requestedDurationRef.current = performance.now() - startedAtRef.current;
    try {
      recorder.stop();
    } catch {
      setError(failureMessage);
      cancel();
      return;
    }
    releaseTracks();
  }, [cancel, clearTimer, releaseTracks, stopSilenceMonitor]);

  const start = useCallback(async () => {
    if (disabledRef.current || startingRef.current || recording || disposedRef.current) return;
    startingRef.current = true;
    onBusyChange?.(true);
    setError('');
    setAutomaticStop(false);
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
      const recorder = new MediaRecorder(acquiredStream, { mimeType });
      recorderRef.current = recorder;
      const activity = new SpeakingEventState((isSpeaking) => onRecordingChangeRef.current?.(isSpeaking), 'start', ['stop', 'error']);
      speakingDetachRef.current = activity.attach(recorder);
      recorder.addEventListener('dataavailable', (event: BlobEvent) => {
        if (operation === operationRef.current && !disposedRef.current) buffer.add(event.data);
      });
      recorder.addEventListener('stop', () => {
        if (operation !== operationRef.current || disposedRef.current) return;
        clearTimer();
        stopSilenceMonitor();
        speakingDetachRef.current?.();
        speakingDetachRef.current = null;
        const duration = requestedDurationRef.current ?? performance.now() - startedAtRef.current;
        const blob = buffer.finish(duration, recorder.mimeType);
        bufferRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        onBusyChange?.(false);
        setElapsedMs(Math.min(duration, MAX_RECORDING_MS));
        releaseTracks();
        if (blob) onRecorded(blob);
        else if (duration >= 250) setError(failureMessage);
      }, { once: true });
      recorder.addEventListener('error', () => {
        setError(failureMessage);
        cancel();
      }, { once: true });
      recorder.start();
      startedAtRef.current = performance.now();
      setRecording(true);
      const monitor = monitorRecordingSilence(acquiredStream, () => {
        if (operation === operationRef.current && !disposedRef.current && !disabledRef.current) stop();
      });
      silenceMonitorRef.current = monitor;
      if (monitor) void monitor.ready.then(available => {
        if (operation === operationRef.current && !disposedRef.current && recorderRef.current === recorder) setAutomaticStop(available);
      });
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
        if (!recorderRef.current) onBusyChange?.(false);
      }
    }
  }, [cancel, disabled, onBusyChange, onRecorded, recording, starting, stop, clearTimer, releaseTracks, stopSilenceMonitor]);

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
    onBusyChange?.(starting || recording);
  }, [onBusyChange, recording, starting]);

  return (
    <div className="grid justify-items-center gap-2 text-center">
      <Button
        type="button"
        size="lg"
        className={`min-h-12 w-full max-w-xs touch-manipulation ${recording ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}`}
        disabled={disabled || starting}
        onClick={recording ? stop : () => void start()}
        aria-label={recording ? 'Stop recording' : starting ? 'Starting microphone' : 'Start recording'}
      >
        {recording ? 'Stop recording' : starting ? 'Starting microphone…' : disabled ? 'Recording unavailable' : 'Start recording'}
      </Button>
      {(starting || recording) && <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
        {recording ? `Recording… ${formatRecordingTime(elapsedMs)} / 0:20` : 'Starting…'}
      </p>}
      {recording && <p className="max-w-md text-xs leading-5 text-muted-foreground">{automaticStop
        ? 'After you speak, about 2 seconds of silence will send your turn. You choose when to start the next one.'
        : 'Silence detection is unavailable. Use Stop recording to send this turn.'}</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}
