import { JwtService } from '@nestjs/jwt';
import type { Provider } from '@nestjs/common';
import { LinguaLoopTokenService, LINGUALOOP_TOKEN_SIGNING_KEY } from './lingualoop-token.service';
import { loadTokenSigningKey } from './token-signing-key.config';
import { ConfiguredVerifiedRequestGuard, REFRESH_SESSION } from './google-auth.providers';
import { GOOGLE_BROWSER_POLICY, createGoogleBrowserPolicy } from './google-browser-policy';
import { GOOGLE_AUTH_RATE_LIMITER, GoogleAuthRateLimiter } from './google-auth.controller';
import { LINGUALOOP_SESSION_STORE, LINGUALOOP_REFRESH_STORE } from './auth-store.providers';
import { SessionStore } from './session-store';
import { RefreshStore } from './refresh-store';
import { RefreshSession } from './refresh-session';
import { RoleGuard } from './role.guard';

export const PASSWORD_AUTH_PROVIDERS: Provider[] = [
  { provide: LINGUALOOP_TOKEN_SIGNING_KEY, useFactory: () => loadTokenSigningKey() },
  { provide: JwtService, useFactory: () => new JwtService({}) },
  { provide: LinguaLoopTokenService, inject: [JwtService, LINGUALOOP_TOKEN_SIGNING_KEY], useFactory: (jwt: JwtService, key: string) => new LinguaLoopTokenService(jwt, key) },
  ConfiguredVerifiedRequestGuard,
  RoleGuard,
  { provide: GOOGLE_AUTH_RATE_LIMITER, useClass: GoogleAuthRateLimiter },
  { provide: GOOGLE_BROWSER_POLICY, useFactory: () => {
    const webOrigin = process.env.LINGUALOOP_WEB_ORIGIN;
    if (!webOrigin) throw new TypeError('LINGUALOOP_WEB_ORIGIN must be explicitly configured.');
    // Only Origin and refresh-cookie policy are active; this local URL is never an OAuth route.
    return createGoogleBrowserPolicy({ webOrigin, callbackUrl: `${webOrigin}/auth/google/callback` });
  } },
  { provide: REFRESH_SESSION, inject: [LINGUALOOP_REFRESH_STORE, LINGUALOOP_SESSION_STORE, LinguaLoopTokenService],
    useFactory: (refresh: RefreshStore, sessions: SessionStore, tokens: LinguaLoopTokenService) => new RefreshSession({ refreshStore: refresh, sessionStore: sessions, tokenService: tokens }) },
];
