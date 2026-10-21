/** One active report audio request/playback, including buttons inside Spanish dialogs. */
export class ExclusiveReportAudio {
  private current: { cancel(): void } | null = null;

  claim(cancel: () => void): () => void {
    const previous = this.current;
    const owner = { cancel };
    this.current = owner;
    previous?.cancel();
    return () => {
      // A late completion/unmount from an old button cannot release the newer one.
      if (this.current === owner) this.current = null;
    };
  }
}

export const reportAudioPlayback = new ExclusiveReportAudio();
