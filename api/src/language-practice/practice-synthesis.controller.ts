import { Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfiguredVerifiedRequestGuard } from '../auth/google-auth.providers';
import { PIPER_RUNTIME, type PiperHostLike } from './piper-runtime.providers';

export class PracticeSynthesisBusyError extends Error {}
const GENERIC_FAILURE = 'Speech synthesis could not be completed.';
const MAX_TEXT_CHARS = 500;
const MAX_TEXT_BYTES = 2_000;

type SynthesisRequest = {
  body?: unknown;
  verifiedIdentity?: { ownerId: string; sessionId: string };
};
type SynthesisResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): SynthesisResponse;
  send(body: Buffer): void;
  json(body: { error: string }): void;
};
type PiperRuntime = { getHost(voice: 'en' | 'es'): PiperHostLike };

@Controller('practice')
export class PracticeSynthesisController {
  private active = false;

  constructor(@Inject(PIPER_RUNTIME) private readonly runtime: PiperRuntime) {}

  @Post('synthesize')
  @UseGuards(ConfiguredVerifiedRequestGuard)
  async synthesize(@Req() request: SynthesisRequest, @Res() response: SynthesisResponse): Promise<void> {
    this.setSafeHeaders(response);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 2 || !Object.hasOwn(body, 'language') || !Object.hasOwn(body, 'text')) {
      this.fail(response, 400);
      return;
    }
    const { language, text } = body as Record<string, unknown>;
    if ((language !== 'en' && language !== 'es') || typeof text !== 'string' || text.length === 0 ||
        text.trim().length === 0 || text.length > MAX_TEXT_CHARS || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES ||
        /[\u0000-\u001f\u007f-\u009f]/.test(text)) {
      this.fail(response, 400);
      return;
    }
    if (!request.verifiedIdentity) {
      this.fail(response, 503);
      return;
    }
    if (this.active) {
      this.fail(response, 429);
      return;
    }
    this.active = true;
    try {
      const wav = await this.runtime.getHost(language).synthesize(text);
      response.setHeader('Content-Type', 'audio/wav');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.status(200).send(wav);
    } catch {
      this.fail(response, 503);
    } finally {
      this.active = false;
    }
  }

  private fail(response: SynthesisResponse, status: number): void {
    response.status(status).json({ error: GENERIC_FAILURE });
  }

  private setSafeHeaders(response: SynthesisResponse): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
}
