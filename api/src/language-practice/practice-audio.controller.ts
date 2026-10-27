import { Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfiguredVerifiedRequestGuard } from '../auth/google-auth.providers';
import { RoleGuard, Roles } from '../auth/role.guard';
import type { AuthenticatedIdentity } from '../auth/verified-request.guard';
import { PracticeAudioBusyError, PracticeAudioService } from './practice-audio.service';

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus',
  'audio/wav', 'audio/x-wav', 'audio/mp4',
]);
const GENERIC_FAILURE = 'Audio transcription could not be completed.';

class AudioRequestTooLargeError extends Error {}

type AudioRequest = {
  headers: { 'content-type'?: string; 'content-length'?: string | string[] };
  verifiedIdentity?: AuthenticatedIdentity;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'aborted' | 'error' | 'close', listener: () => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  resume(): void;
};
type AudioResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): AudioResponse;
  json(body: unknown): void;
  headersSent?: boolean;
};

@Controller('practice')
export class PracticeAudioController {
  constructor(@Inject(PracticeAudioService) private readonly audio: Pick<PracticeAudioService, 'transcribe'>) {}

  @Post('transcribe')
  @UseGuards(ConfiguredVerifiedRequestGuard, RoleGuard)
  @Roles('student')
  async transcribe(@Req() request: AudioRequest, @Res() response: AudioResponse): Promise<void> {
    this.setSafeHeaders(response);
    const mimeType = request.headers['content-type'];
    const contentLength = request.headers['content-length'];
    if (typeof mimeType !== 'string' || !ALLOWED_AUDIO_TYPES.has(mimeType)) {
      response.status(415).json({ error: GENERIC_FAILURE });
      request.resume();
      return;
    }
    if (contentLength !== undefined && (typeof contentLength !== 'string' || !/^\d+$/.test(contentLength) ||
        !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > MAX_AUDIO_BYTES)) {
      response.status(413).json({ error: GENERIC_FAILURE });
      request.resume();
      return;
    }

    let input: Buffer | undefined;
    try {
      input = await this.readBoundedBody(request);
    } catch (error) {
      if (!response.headersSent) {
        response.status(error instanceof AudioRequestTooLargeError ? 413 : 400).json({ error: GENERIC_FAILURE });
      }
      return;
    }
    if (!input) return;

    // The guard's verified identity is the sole authority; no caller-supplied user/session data is read.
    if (!request.verifiedIdentity) {
      response.status(503).json({ error: GENERIC_FAILURE });
      return;
    }
    try {
      const transcript = await this.audio.transcribe(input, mimeType);
      response.status(200).json({ transcript });
    } catch (error) {
      if (error instanceof PracticeAudioBusyError) {
        response.status(429).json({ error: GENERIC_FAILURE });
        return;
      }
      if (!response.headersSent) response.status(503).json({ error: GENERIC_FAILURE });
    }
  }

  private readBoundedBody(request: AudioRequest): Promise<Buffer | undefined> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const cleanup = () => {
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('aborted', onAbort);
        request.off('error', onAbort);
        request.off('close', onClose);
      };
      const finish = (error?: Error, body?: Buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(body);
      };
      const onData = (chunk: Buffer) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_AUDIO_BYTES) {
          finish(new AudioRequestTooLargeError());
          request.resume();
          return;
        }
        chunks.push(bytes);
      };
      const onEnd = () => finish(undefined, Buffer.concat(chunks, total));
      const onAbort = () => finish(new Error('Audio request aborted'));
      const onClose = () => { if (!settled) onAbort(); };
      request.on('data', onData);
      request.on('end', onEnd);
      request.on('aborted', onAbort);
      request.on('error', onAbort);
      request.on('close', onClose);
    });
  }

  private setSafeHeaders(response: AudioResponse): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
}
