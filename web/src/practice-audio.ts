export const MAX_RECORDING_MS = 20_000;
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
] as const;

export function selectSupportedAudioMimeType(
  recorder: Pick<typeof MediaRecorder, 'isTypeSupported'> | undefined =
    typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
): string | null {
  if (!recorder) return null;
  return ALLOWED_AUDIO_MIME_TYPES.find((mimeType) => recorder.isTypeSupported(mimeType)) ?? null;
}

export function transcriptionErrorMessage(error: string): string {
  switch (error) {
    case 'too-large': return 'This recording is too large. Keep it under 2 MiB and try again.';
    case 'unsupported': return 'The server cannot process this audio format.';
    case 'rate-limited': return 'Too many transcription requests. Please wait and try again.';
    case 'unavailable': return 'Transcription is temporarily unavailable or timed out. Please try again.';
    default: return 'The recording could not be transcribed. Please try again.';
  }
}
