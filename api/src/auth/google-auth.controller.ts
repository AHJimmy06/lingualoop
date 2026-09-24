import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { GoogleAuthFlow } from './google-auth-flow';
import { GOOGLE_AUTH_FLOW, REFRESH_SESSION } from './google-auth.providers';
import type { RefreshSession } from './refresh-session';
import { createGoogleBrowserPolicy, GOOGLE_BROWSER_POLICY } from './google-browser-policy';

const WINDOW_MS = 60_000;
const MAX_STARTS = 10;
const MAX_CALLBACKS = 30;
const MAX_REFRESHES = 30;
const MAX_CLIENTS = 10_000;
const GENERIC_FAILURE = 'Google login could not be completed.';

type GoogleHttpRequest = {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: { cookie?: string; origin?: string };
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
  private readonly buckets = new Map<string, { window: number; starts: number; callbacks: number; refreshes: number }>();

  allow(address: string, kind: 'start' | 'callback' | 'refresh', now = Date.now()): boolean {
    const key = typeof address === 'string' && address.length <= 128 ? address : 'unknown';
    let bucket = this.buckets.get(key);
    const window = Math.floor(now / WINDOW_MS);
    if (!bucket || bucket.window !== window) bucket = { window, starts: 0, callbacks: 0, refreshes: 0 };
    const count = kind === 'start' ? ++bucket.starts : kind === 'callback' ? ++bucket.callbacks : ++bucket.refreshes;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > MAX_CLIENTS) this.buckets.delete(this.buckets.keys().next().value!);
    return count <= (kind === 'start' ? MAX_STARTS : kind === 'callback' ? MAX_CALLBACKS : MAX_REFRESHES);
  }
}

export const GOOGLE_AUTH_RATE_LIMITER = Symbol('GOOGLE_AUTH_RATE_LIMITER');

@Controller()
export class GoogleAuthController {
  constructor(
    @Inject(GOOGLE_AUTH_FLOW) private readonly flow: Pick<GoogleAuthFlow, 'begin' | 'finish' | 'clearStateCookie'>,
    @Inject(GOOGLE_AUTH_RATE_LIMITER) private readonly limiter: GoogleAuthRateLimiter,
    @Inject(REFRESH_SESSION) private readonly refreshSession: Pick<RefreshSession, 'refresh'>,
    @Inject(GOOGLE_BROWSER_POLICY) private readonly browserPolicy: ReturnType<typeof createGoogleBrowserPolicy>,
  ) {}

  @Get('auth/google')
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

  @Get('auth/google/callback')
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

  @Post('auth/refresh')
  async refresh(@Req() request: GoogleHttpRequest, @Res() response: GoogleHttpResponse): Promise<void> {
    this.setSafeHeaders(response);
    // Origin is the first gate: cross-origin requests never parse cookies, touch providers, or clear them.
    if (!this.browserPolicy.isAllowedRefreshOrLogoutOrigin(request.headers.origin)) {
      response.status(403).send(GENERIC_FAILURE);
      return;
    }
    if (!this.limiter.allow(request.socket?.remoteAddress ?? '', 'refresh')) {
      response.setHeader('Set-Cookie', this.browserPolicy.clearRefreshCookie());
      response.status(429).send(GENERIC_FAILURE);
      return;
    }
    let result: Awaited<ReturnType<RefreshSession['refresh']>> | undefined;
    try {
      const credential = this.browserPolicy.readRefreshCredential(request.headers.cookie);
      result = await this.refreshSession.refresh(credential);
      // Assemble all values before writing any rotated credential to the response.
      const rotatedCookie = this.browserPolicy.refreshCookie(result.refreshCredential, result.expiresAtMs, Date.now());
      const body = JSON.stringify({ accessToken: result.accessToken });
      response.setHeader('Set-Cookie', rotatedCookie);
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.status(200).send(body);
    } catch {
      if (result) await result.compensateDeliveryFailure();
      response.setHeader('Set-Cookie', this.browserPolicy.clearRefreshCookie());
      response.status(401).send(GENERIC_FAILURE);
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
