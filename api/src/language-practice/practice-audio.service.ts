import { Inject, Injectable } from '@nestjs/common';
import { withPreparedAudio } from './audio-preparation';
import { PRACTICE_FFMPEG_PATH, PRACTICE_RUNTIME, type PracticeRuntimeHost } from './practice-runtime.providers';

export const PRACTICE_AUDIO_PREPARER = Symbol('PRACTICE_AUDIO_PREPARER');
export type PracticeAudioPreparer = <T>(
  input: Buffer,
  mimeType: string,
  callback: (wavPath: string) => Promise<T>,
  options: { ffmpegExecutable: string },
) => Promise<T>;

export class PracticeAudioBusyError extends Error {}

@Injectable()
export class PracticeAudioService {
  private active = false;

  constructor(
    @Inject(PRACTICE_RUNTIME) private readonly runtime: Pick<PracticeRuntimeHost, 'getHost'>,
    @Inject(PRACTICE_FFMPEG_PATH) private readonly ffmpegExecutable: string,
    @Inject(PRACTICE_AUDIO_PREPARER) private readonly prepare: PracticeAudioPreparer,
  ) {}

  async transcribe(input: Buffer, mimeType: string): Promise<string> {
    if (this.active) throw new PracticeAudioBusyError();
    this.active = true;
    try {
      return await this.prepare(input, mimeType,
        (wavPath) => this.runtime.getHost().transcribe(wavPath),
        { ffmpegExecutable: this.ffmpegExecutable });
    } finally {
      this.active = false;
    }
  }
}

export const practiceAudioPreparer: PracticeAudioPreparer = (input, mimeType, callback, options) =>
  withPreparedAudio(input, mimeType, callback, options);
