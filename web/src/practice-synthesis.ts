export const MAX_SYNTHESIS_TEXT_CHARS = 500;
export const MAX_SYNTHESIS_TEXT_BYTES = 2_000;
export const MAX_SYNTHESIS_WAV_BYTES = 8 * 1024 * 1024;

export type SynthesisLanguage = 'en' | 'es';
export type SynthesisError = 'invalid-text' | 'not-found' | 'unavailable' | 'rate-limited' | 'failed';

export type SynthesisResult =
  | { ok: true; wav: Blob }
  | { ok: false; error: SynthesisError | 'unauthorized' };

export function validateSynthesisText(text: string): SynthesisError | null {
  if (text.trim().length === 0 || text.length > MAX_SYNTHESIS_TEXT_CHARS ||
      new TextEncoder().encode(text).byteLength > MAX_SYNTHESIS_TEXT_BYTES || /[\u0000-\u001f\u007f-\u009f]/.test(text)) {
    return 'invalid-text';
  }
  return null;
}

export async function validateWavBlob(blob: Blob): Promise<boolean> {
  if (blob.size <= 44 || blob.size > MAX_SYNTHESIS_WAV_BYTES || blob.type.split(';', 1)[0].trim().toLowerCase() !== 'audio/wav') {
    return false;
  }
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  return String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WAVE';
}

export function synthesisErrorMessage(error: SynthesisError): string {
  switch (error) {
    case 'invalid-text': return 'Enter up to 500 characters and 2,000 UTF-8 bytes without control characters.';
    case 'not-found': return 'Speech synthesis is not enabled on this server (404).';
    case 'unavailable': return 'Speech synthesis is temporarily unavailable or timed out. Please try again.';
    case 'rate-limited': return 'Speech synthesis is busy. Please wait and try again.';
    default: return 'Speech could not be synthesized. Please try again.';
  }
}

export function releaseAudio(audio: HTMLAudioElement | null, objectUrl: string | null): void {
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
}
