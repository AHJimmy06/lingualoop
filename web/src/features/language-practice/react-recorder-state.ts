import { isValidRecording } from './practice-recorder-guards';

/** Collects MediaRecorder chunks and produces at most one bounded recording. */
export class RecordingBuffer {
  private chunks: Blob[] = [];
  private finished = false;

  add(chunk: Blob): void {
    if (!this.finished && chunk.size > 0) this.chunks.push(chunk);
  }

  finish(durationMs: number, mimeType: string): Blob | null {
    if (this.finished) return null;
    this.finished = true;
    const type = mimeType || this.chunks.find((chunk) => chunk.type)?.type || 'application/octet-stream';
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    return isValidRecording(durationMs, blob.size) ? blob : null;
  }
}
