import { isValidRecording, MAX_AUDIO_BYTES } from './practice-recorder-guards';

/** Collects MediaRecorder chunks and produces at most one bounded recording. */
export class RecordingBuffer {
  private chunks: Blob[] = [];
  private finished = false;
  private size = 0;
  overflowed = false;

  add(chunk: Blob): void {
    if (this.finished || this.overflowed || chunk.size === 0) return;
    this.size += chunk.size;
    if (this.size > MAX_AUDIO_BYTES) { this.overflowed = true; this.chunks = []; return; }
    this.chunks.push(chunk);
  }

  finish(durationMs: number, mimeType: string): Blob | null {
    if (this.finished || this.overflowed) return null;
    this.finished = true;
    const type = mimeType || this.chunks.find((chunk) => chunk.type)?.type || 'application/octet-stream';
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    return isValidRecording(durationMs, blob.size) ? blob : null;
  }
}
