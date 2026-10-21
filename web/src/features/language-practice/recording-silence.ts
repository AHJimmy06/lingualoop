export const TURN_SILENCE_MS = 2_000;
export const MIN_VOICE_ACTIVITY_MS = 200;
const VOICE_RMS_THRESHOLD = 0.015;

/** Conservative energy detector, not speech recognition. Initial silence never submits. */
export class RecordingSilenceDetector {
  private voiceSince: number | null = null;
  private lastSoundAt = 0;
  private finished = false;
  hasVoiceActivity = false;

  observe(rms: number, now: number): boolean {
    if (this.finished || !Number.isFinite(rms) || rms < 0 || !Number.isFinite(now)) return false;
    if (rms >= VOICE_RMS_THRESHOLD) {
      this.voiceSince ??= now;
      this.lastSoundAt = now;
      if (now - this.voiceSince >= MIN_VOICE_ACTIVITY_MS) this.hasVoiceActivity = true;
    } else {
      this.voiceSince = null;
      if (this.hasVoiceActivity && now - this.lastSoundAt >= TURN_SILENCE_MS) {
        this.finished = true;
        return true;
      }
    }
    return false;
  }
}

export type RecordingSilenceMonitor = { ready: Promise<boolean>; stop(): void };

/** Analyse only the explicitly opened microphone. Never connects to speakers or opens another mic. */
export function monitorRecordingSilence(stream: MediaStream, onSilence: () => void): RecordingSilenceMonitor | null {
  const Context = globalThis.AudioContext;
  if (typeof Context !== 'function') return null;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (interval !== undefined) clearInterval(interval);
    try { source?.disconnect(); } catch { /* Best-effort audio cleanup. */ }
    try { analyser?.disconnect(); } catch { /* Best-effort audio cleanup. */ }
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  };
  try {
    context = new Context();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const detector = new RecordingSilenceDetector();
    const ready = (async () => {
      try {
        if (context!.state !== 'running') await context!.resume();
        if (stopped) return false;
        if (context!.state !== 'running') { stop(); return false; }
        interval = setInterval(() => {
          if (stopped || context!.state !== 'running') return;
          try {
            analyser!.getFloatTimeDomainData(samples);
            let energy = 0;
            for (const sample of samples) energy += sample * sample;
            if (detector.observe(Math.sqrt(energy / samples.length), performance.now())) {
              stop();
              onSilence();
            }
          } catch { stop(); }
        }, 100);
        return true;
      } catch { stop(); return false; }
    })();
    return { ready, stop };
  } catch { stop(); return null; }
}
