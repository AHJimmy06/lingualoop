type AudioResponse = { audioBase64: string | null; audioMimeType: 'audio/wav' | null };
type ObjectUrlApi = Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
type EventSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Derives a speaking flag exclusively from lifecycle events emitted by its media source. */
export class SpeakingEventState {
  speaking = false;
  private detachCurrent: (() => void) | null = null;

  constructor(
    private readonly onChange: (speaking: boolean) => void,
    private readonly startEvent: string,
    private readonly endEvents: string[],
    private readonly canStart: () => boolean = () => true,
  ) {}

  attach(source: EventSource): () => void {
    this.detachCurrent?.();
    let attached = true;
    const begin = () => { if (attached && this.canStart()) this.setSpeaking(true); };
    const end = () => { if (attached) this.setSpeaking(false); };
    source.addEventListener(this.startEvent, begin);
    this.endEvents.forEach((event) => source.addEventListener(event, end));
    const detach = () => {
      if (!attached) return;
      attached = false;
      source.removeEventListener(this.startEvent, begin);
      this.endEvents.forEach((event) => source.removeEventListener(event, end));
      if (this.detachCurrent === detach) this.detachCurrent = null;
      this.setSpeaking(false);
    };
    this.detachCurrent = detach;
    return detach;
  }

  clear(): void {
    this.detachCurrent?.();
    this.setSpeaking(false);
  }

  protected stopSpeaking(): void {
    this.setSpeaking(false);
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.onChange(speaking);
  }
}

/** Partner speech begins only at `playing`, never at a play request or while loading. */
export class ResponseAudioPlayback extends SpeakingEventState {
  private recording = false;

  constructor(onChange: (speaking: boolean) => void) {
    super(onChange, 'playing', ['pause', 'ended', 'error', 'emptied'], () => !this.recording);
  }

  setRecording(recording: boolean): void {
    this.recording = recording;
    if (recording) this.stopSpeaking();
  }
}

/** Stop audible partner speech before publishing the learner's actual recording state. */
export function onRecordingActivity(
  recording: boolean,
  audio: Pick<HTMLMediaElement, 'pause'> | null,
  onChange: (recording: boolean) => void,
  onPartnerStopped: () => void,
  playback: ResponseAudioPlayback,
): void {
  playback.setRecording(recording);
  if (recording) {
    audio?.pause();
    onPartnerStopped();
  }
  onChange(recording);
}

export class ResponseAudioUrls {
  url: string | null = null;
  manualReplayRequired = false;

  constructor(private readonly objectUrls: ObjectUrlApi = URL) {}

  replace(response: AudioResponse): string | null {
    this.clear();
    if (!response.audioBase64 || response.audioMimeType !== 'audio/wav') return null;
    try {
      const binary = atob(response.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      this.url = this.objectUrls.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      return this.url;
    } catch {
      return null;
    }
  }

  async autoplay(play: () => Promise<unknown>): Promise<boolean> {
    if (!this.url) return false;
    try {
      await play();
      this.manualReplayRequired = false;
      return true;
    } catch {
      this.manualReplayRequired = true;
      return false;
    }
  }

  async replay(play: () => Promise<unknown>): Promise<boolean> {
    this.manualReplayRequired = false;
    try {
      await play();
      return true;
    } catch {
      this.manualReplayRequired = true;
      return false;
    }
  }

  clear(): void {
    if (this.url) this.objectUrls.revokeObjectURL(this.url);
    this.url = null;
    this.manualReplayRequired = false;
  }
}
