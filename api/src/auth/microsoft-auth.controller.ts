import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { MicrosoftAuthFlow } from './microsoft-auth-flow';
import { GOOGLE_AUTH_RATE_LIMITER, GoogleAuthRateLimiter } from './google-auth.controller';
import { MICROSOFT_AUTH_FLOW, externalProviderAvailability } from './external-auth.providers';

type Request = { ip?: string; headers: { cookie?: string }; query: { state?: unknown; code?: unknown; error?: unknown } };
type Response = { setHeader(name: string, value: string | string[]): void; status(code: number): Response; send(body: string): void; redirect(code: number, url: string): void };
const FAILURE = 'Microsoft login could not be completed.';

@Controller('auth')
export class MicrosoftAuthController {
  constructor(@Inject(MICROSOFT_AUTH_FLOW) private readonly flow: Pick<MicrosoftAuthFlow, 'begin' | 'finish' | 'clearStateCookie' | 'clearNonceCookie' | 'failureRedirectUrl'>,
    @Inject(GOOGLE_AUTH_RATE_LIMITER) private readonly limiter: GoogleAuthRateLimiter) {}

  @Get('microsoft')
  async start(@Req() request: Request, @Res() response: Response) {
    this.headers(response);
    if (!this.limiter.allow(request.ip ?? '', 'start')) { response.status(429).send(FAILURE); return; }
    try {
      const result = await this.flow.begin();
      response.setHeader('Set-Cookie', [result.stateCookie, result.nonceCookie]);
      response.redirect(302, result.authorizationUrl);
    } catch {
      response.setHeader('Set-Cookie', [this.flow.clearStateCookie(), this.flow.clearNonceCookie()]);
      response.status(503).send(FAILURE);
    }
  }

  @Get('microsoft/callback')
  async callback(@Req() request: Request, @Res() response: Response) {
    this.headers(response);
    if (!this.limiter.allow(request.ip ?? '', 'callback')) {
      response.setHeader('Set-Cookie', [this.flow.clearStateCookie(), this.flow.clearNonceCookie()]);
      response.status(429).send(FAILURE); return;
    }
    try {
      const result = await this.flow.finish({ cookieHeader: request.headers.cookie, state: request.query.state, code: request.query.code, error: request.query.error });
      response.setHeader('Set-Cookie', [result.stateCookie, result.nonceCookie, result.refreshCookie]);
      response.redirect(302, result.redirectUrl);
    } catch {
      response.setHeader('Set-Cookie', [this.flow.clearStateCookie(), this.flow.clearNonceCookie()]);
      response.redirect(302, this.flow.failureRedirectUrl());
    }
  }

  private headers(response: Response) {
    response.setHeader('Cache-Control', 'no-store, max-age=0'); response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
}

@Controller('auth')
export class AuthProvidersController {
  @Get('providers')
  providers() { return externalProviderAvailability(); }
}
