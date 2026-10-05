type AudioResponse = { audioBase64: string | null; audioMimeType: 'audio/wav' | null };
type ObjectUrlApi = Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;

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
