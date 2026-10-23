import { Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfiguredVerifiedRequestGuard, REFRESH_SESSION } from './google-auth.providers';
import { GOOGLE_AUTH_RATE_LIMITER, GoogleAuthRateLimiter } from './google-auth.controller';
import { GOOGLE_BROWSER_POLICY, createGoogleBrowserPolicy } from './google-browser-policy';
import { RefreshSession } from './refresh-session';
import { parseRefreshCredential } from './refresh-credential';
import type { AuthenticatedIdentity } from './verified-request.guard';

type Request = { socket?: { remoteAddress?: string }; headers: { origin?: string; cookie?: string }; verifiedIdentity?: AuthenticatedIdentity };
type Response = { setHeader(name: string, value: string): void; status(code: number): Response; send(body: string): void };
@Controller('auth')
export class PasswordAuthController {
  constructor(@Inject(GOOGLE_AUTH_RATE_LIMITER) private readonly limiter: GoogleAuthRateLimiter,
    @Inject(REFRESH_SESSION) private readonly refreshSession: Pick<RefreshSession, 'refresh' | 'logout'>,
    @Inject(GOOGLE_BROWSER_POLICY) private readonly policy: ReturnType<typeof createGoogleBrowserPolicy>) {}

  private headers(response: Response) {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  // Sign-in is exclusively handled by the Google and Microsoft OAuth controllers.
  @Post('refresh')
  async refresh(@Req() request: Request, @Res() response: Response) {
    this.headers(response);
    if (!this.policy.isAllowedRefreshOrLogoutOrigin(request.headers.origin)) { response.status(403).send('Forbidden.'); return; }
    if (!this.limiter.allow(request.socket?.remoteAddress ?? '', 'refresh')) {
      response.setHeader('Set-Cookie', this.policy.clearRefreshCookie());
      response.status(429).send('Too many requests.'); return;
    }
    let result: Awaited<ReturnType<RefreshSession['refresh']>> | undefined;
    try {
      result = await this.refreshSession.refresh(this.policy.readRefreshCredential(request.headers.cookie));
      const cookie = this.policy.refreshCookie(result.refreshCredential, result.expiresAtMs, Date.now());
      const body = JSON.stringify({ accessToken: result.accessToken });
      response.setHeader('Set-Cookie', cookie);
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.status(200).send(body);
    } catch {
      if (result) await result.compensateDeliveryFailure();
      response.setHeader('Set-Cookie', this.policy.clearRefreshCookie());
      response.status(401).send('Unauthorized.');
    }
  }
  @Post('logout')
  @UseGuards(ConfiguredVerifiedRequestGuard)
  async logout(@Req() request: Request, @Res() response: Response) {
    this.headers(response);
    if (!this.policy.isAllowedRefreshOrLogoutOrigin(request.headers.origin)) { response.status(403).send('Forbidden.'); return; }
    response.setHeader('Set-Cookie', this.policy.clearRefreshCookie());
    if (!this.limiter.allow(request.socket?.remoteAddress ?? '', 'logout')) { response.status(429).send('Too many requests.'); return; }
    try {
      const identity = request.verifiedIdentity;
      if (!identity) throw new Error();
      const credential = this.policy.readOptionalRefreshCredential(request.headers.cookie);
      if (credential !== undefined && parseRefreshCredential(credential).sessionUuid.toLowerCase() !== identity.sessionId.toLowerCase()) throw new Error();
      await this.refreshSession.logout({ ownerId: identity.ownerId, sessionId: identity.sessionId });
      response.status(204).send('');
    } catch { response.status(401).send('Unauthorized.'); }
  }
}
