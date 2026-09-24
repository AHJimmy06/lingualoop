import { Inject, Injectable, type Provider } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OAuthStateService } from './oauth-state.service';
import { GoogleAuthFlow } from './google-auth-flow';
import { GoogleCodeExchange } from './google-code-exchange';
import { GoogleIdentityService } from './google-identity.service';
import { loadGoogleOAuthConfig } from './google-oauth.config';
import { GoogleLoginSession } from './google-login-session';
import { LinguaLoopTokenService, LINGUALOOP_TOKEN_SIGNING_KEY } from './lingualoop-token.service';
import { loadTokenSigningKey } from './token-signing-key.config';
import { VerifiedRequestGuard } from './verified-request.guard';
import { RefreshSession } from './refresh-session';
import { createGoogleBrowserPolicy, GOOGLE_BROWSER_POLICY } from './google-browser-policy';
import {
  LINGUALOOP_IDENTITY_STORE,
  LINGUALOOP_OAUTH_STATE_STORE,
  LINGUALOOP_REFRESH_STORE,
  LINGUALOOP_SESSION_STORE,
} from './auth-store.providers';

export const GOOGLE_AUTH_FLOW = Symbol('GOOGLE_AUTH_FLOW');
export const REFRESH_SESSION = Symbol('REFRESH_SESSION');

@Injectable()
export class ConfiguredVerifiedRequestGuard extends VerifiedRequestGuard {
  constructor(
    @Inject(LinguaLoopTokenService) verifier: LinguaLoopTokenService,
    @Inject(LINGUALOOP_IDENTITY_STORE) owners: { findOwnerByIdentity(identity: { issuer: string; subject: string }): Promise<string | null> },
    @Inject(LINGUALOOP_SESSION_STORE) sessions: { isSessionActive(ownerId: string, sessionId: string, nowMs: number): Promise<boolean> },
  ) {
    super(verifier, owners, sessions);
  }
}

export function isGoogleAuthConfigurationValid(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const config = loadGoogleOAuthConfig(env);
    const clientId = requiredSetting('GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID);
    const clientSecret = requiredSetting('GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET);
    const audience = requiredSetting('LINGUALOOP_GOOGLE_AUDIENCE', env.LINGUALOOP_GOOGLE_AUDIENCE);
    const signingKey = loadTokenSigningKey(env);

    // Reuse the same constructors as the runtime providers; none performs network or database I/O.
    new GoogleCodeExchange({ env: { ...env, GOOGLE_CALLBACK_URL: config.callbackUrl, GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } });
    new GoogleIdentityService(audience);
    new LinguaLoopTokenService(new JwtService({}), signingKey);
    new GoogleAuthFlow({
      ...config,
      clientId,
      stateService: { async createState() { return ''; }, async consumeState() {} },
      codeExchange: { async exchange() { return { idToken: '' }; } },
      loginSession: { async issue() { return { accessToken: '', refreshCredential: '', expiresAtMs: 1 }; } },
    });
    createGoogleBrowserPolicy(config);
    return true;
  } catch {
    return false;
  }
}

function requiredSetting(name: string, value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be explicitly configured.`);
  }
  return value;
}

export const GOOGLE_AUTH_PROVIDERS: Provider[] = [
  { provide: LINGUALOOP_TOKEN_SIGNING_KEY, useFactory: () => loadTokenSigningKey() },
  { provide: JwtService, useFactory: () => new JwtService({}) },
  {
    provide: GoogleCodeExchange,
    useFactory: () => new GoogleCodeExchange(),
  },
  {
    provide: GoogleIdentityService,
    useFactory: () => new GoogleIdentityService(requiredSetting('LINGUALOOP_GOOGLE_AUDIENCE', process.env.LINGUALOOP_GOOGLE_AUDIENCE)),
  },
  {
    provide: LinguaLoopTokenService,
    inject: [JwtService, LINGUALOOP_TOKEN_SIGNING_KEY],
    useFactory: (jwt: JwtService, key: string) => new LinguaLoopTokenService(jwt, key),
  },
  {
    provide: OAuthStateService,
    inject: [LINGUALOOP_OAUTH_STATE_STORE],
    useFactory: (store: ConstructorParameters<typeof OAuthStateService>[0]) => new OAuthStateService(store),
  },
  {
    provide: GoogleLoginSession,
    inject: [GoogleIdentityService, LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE, LINGUALOOP_REFRESH_STORE, LinguaLoopTokenService],
    useFactory: (identity: GoogleIdentityService, owners: ConstructorParameters<typeof GoogleLoginSession>[0]['identityStore'], sessions: ConstructorParameters<typeof GoogleLoginSession>[0]['sessionStore'], refresh: ConstructorParameters<typeof GoogleLoginSession>[0]['refreshStore'], tokens: LinguaLoopTokenService) => new GoogleLoginSession({
      googleIdentityService: identity,
      identityStore: owners,
      sessionStore: sessions,
      refreshStore: refresh,
      tokenService: tokens,
    }),
  },
  {
    provide: GOOGLE_BROWSER_POLICY,
    useFactory: () => createGoogleBrowserPolicy({
      callbackUrl: requiredSetting('GOOGLE_CALLBACK_URL', process.env.GOOGLE_CALLBACK_URL),
      webOrigin: requiredSetting('LINGUALOOP_WEB_ORIGIN', process.env.LINGUALOOP_WEB_ORIGIN),
    }),
  },
  { provide: ConfiguredVerifiedRequestGuard, useClass: ConfiguredVerifiedRequestGuard },
  {
    provide: REFRESH_SESSION,
    inject: [LINGUALOOP_REFRESH_STORE, LINGUALOOP_SESSION_STORE, LinguaLoopTokenService],
    useFactory: (refresh: ConstructorParameters<typeof RefreshSession>[0]['refreshStore'], sessions: ConstructorParameters<typeof RefreshSession>[0]['sessionStore'], tokens: ConstructorParameters<typeof RefreshSession>[0]['tokenService']) => new RefreshSession({ refreshStore: refresh, sessionStore: sessions, tokenService: tokens }),
  },
  {
    provide: GOOGLE_AUTH_FLOW,
    inject: [GoogleCodeExchange, GoogleLoginSession, OAuthStateService],
    useFactory: (exchange: GoogleCodeExchange, session: GoogleLoginSession, state: OAuthStateService) => new GoogleAuthFlow({
      callbackUrl: requiredSetting('GOOGLE_CALLBACK_URL', process.env.GOOGLE_CALLBACK_URL),
      webOrigin: requiredSetting('LINGUALOOP_WEB_ORIGIN', process.env.LINGUALOOP_WEB_ORIGIN),
      clientId: requiredSetting('GOOGLE_CLIENT_ID', process.env.GOOGLE_CLIENT_ID),
      codeExchange: exchange,
      loginSession: session,
      stateService: state,
    }),
  },
];
