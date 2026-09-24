import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { GoogleAuthFlow } from './google-auth-flow';
import { GOOGLE_AUTH_FLOW } from './google-auth.providers';

const WINDOW_MS = 60_000;
const MAX_STARTS = 10;
const MAX_CALLBACKS = 30;
const MAX_CLIENTS = 10_000;
const GENERIC_FAILURE = 'Google login could not be completed.';

type GoogleHttpRequest = {
  ip?: string;
  headers: { cookie?: string };
  query: { state?: unknown; code?: unknown; error?: unknown };
};
type GoogleHttpResponse = {
  setHeader(name: string, value: string | string[]): void;
  status(code: number): GoogleHttpResponse;
  send(body: string): void;
  redirect(code: number, url: string): void;
};

/** Small per-process limiter with bounded state; Express's untrusted forwarded headers are ignored. */
export class GoogleAuthRateLimiter {
  private readonly buckets = new Map<string, { window: number; starts: number; callbacks: number }>();

  allow(address: string, kind: 'start' | 'callback', now = Date.now()): boolean {
    const key = typeof address === 'string' && address.length <= 128 ? address : 'unknown';
    let bucket = this.buckets.get(key);
    const window = Math.floor(now / WINDOW_MS);
    if (!bucket || bucket.window !== window) bucket = { window, starts: 0, callbacks: 0 };
    const count = kind === 'start' ? ++bucket.starts : ++bucket.callbacks;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > MAX_CLIENTS) this.buckets.delete(this.buckets.keys().next().value!);
    return count <= (kind === 'start' ? MAX_STARTS : MAX_CALLBACKS);
  }
}

export const GOOGLE_AUTH_RATE_LIMITER = Symbol('GOOGLE_AUTH_RATE_LIMITER');

@Controller('auth/google')
export class GoogleAuthController {
  constructor(
    @Inject(GOOGLE_AUTH_FLOW) private readonly flow: Pick<GoogleAuthFlow, 'begin' | 'finish' | 'clearStateCookie'>,
    @Inject(GOOGLE_AUTH_RATE_LIMITER) private readonly limiter: GoogleAuthRateLimiter,
  ) {}

  @Get()
  async start(@Req() request: GoogleHttpRequest, @Res() response: GoogleHttpResponse): Promise<void> {
    this.setSafeHeaders(response);
    if (!this.limiter.allow(request.ip ?? '', 'start')) {
      response.setHeader('Set-Cookie', this.flow.clearStateCookie());
      response.status(429).send(GENERIC_FAILURE);
      return;
    }
    try {
      const result = await this.flow.begin();
      response.setHeader('Set-Cookie', result.stateCookie);
      response.redirect(302, result.authorizationUrl);
    } catch {
      response.setHeader('Set-Cookie', this.flow.clearStateCookie());
      response.status(503).send(GENERIC_FAILURE);
    }
  }

  @Get('callback')
  async callback(@Req() request: GoogleHttpRequest, @Res() response: GoogleHttpResponse): Promise<void> {
    this.setSafeHeaders(response);
    if (!this.limiter.allow(request.ip ?? '', 'callback')) {
      response.setHeader('Set-Cookie', this.flow.clearStateCookie());
      response.status(429).send(GENERIC_FAILURE);
      return;
    }
    try {
      const result = await this.flow.finish({
        cookieHeader: request.headers.cookie,
        state: request.query.state,
        code: request.query.code,
        error: request.query.error,
      });
      response.setHeader('Set-Cookie', [result.stateCookie, result.refreshCookie]);
      response.redirect(302, result.redirectUrl);
    } catch {
      response.setHeader('Set-Cookie', this.flow.clearStateCookie());
      response.status(400).send(GENERIC_FAILURE);
    }
  }

  private setSafeHeaders(response: GoogleHttpResponse): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
}
