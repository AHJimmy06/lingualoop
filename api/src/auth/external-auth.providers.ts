import type { Provider } from '@nestjs/common';
import { GoogleAuthFlow } from './google-auth-flow';
import { GoogleCodeExchange } from './google-code-exchange';
import { GoogleIdentityService } from './google-identity.service';
import { GoogleLoginSession } from './google-login-session';
import { MicrosoftAuthFlow } from './microsoft-auth-flow';
import { MicrosoftCodeExchange } from './microsoft-code-exchange';
import { MicrosoftIdentityService } from './microsoft-identity.service';
import { loadMicrosoftOAuthConfig } from './microsoft-oauth.config';
import { IdentityStore } from './identity-store';
import { OAuthStateDbStore } from './oauth-state-db';
import { OAuthStateService } from './oauth-state.service';
import { LinguaLoopTokenService } from './lingualoop-token.service';
import { LINGUALOOP_QUERY_EXECUTOR } from '../db/postgres';
import { LINGUALOOP_IDENTITY_STORE, LINGUALOOP_OAUTH_STATE_STORE, LINGUALOOP_REFRESH_STORE, LINGUALOOP_SESSION_STORE } from './auth-store.providers';
import type { SessionStore } from './session-store';
import type { RefreshStore } from './refresh-store';
import { loadGoogleOAuthConfig } from './google-oauth.config';
import { GOOGLE_AUTH_FLOW } from './google-auth.providers';
import { loadTokenSigningKey } from './token-signing-key.config';

export const MICROSOFT_AUTH_FLOW = Symbol('MICROSOFT_AUTH_FLOW');
export function createExternalAuthProviders(availability: { google: boolean; microsoft: boolean }): Provider[] {
  if (!availability.google && !availability.microsoft) return [];
  const providers: Provider[] = [
  { provide: LINGUALOOP_OAUTH_STATE_STORE, inject: [LINGUALOOP_QUERY_EXECUTOR], useFactory: executor => new OAuthStateDbStore(executor) },
  { provide: OAuthStateService, inject: [LINGUALOOP_OAUTH_STATE_STORE], useFactory: store => new OAuthStateService(store) },
  { provide: GoogleLoginSession, inject: [LINGUALOOP_IDENTITY_STORE, LINGUALOOP_SESSION_STORE, LINGUALOOP_REFRESH_STORE, LinguaLoopTokenService],
    useFactory: (identities: IdentityStore, sessions: SessionStore, refresh: RefreshStore, tokens: LinguaLoopTokenService) =>
      new GoogleLoginSession({ googleIdentityService: { verify: (token, nonce, accessToken) => nonce
        ? new MicrosoftIdentityService(process.env.MICROSOFT_CLIENT_ID ?? '').verify(token, nonce, accessToken)
        : new GoogleIdentityService(process.env.GOOGLE_CLIENT_ID ?? '').verify(token) },
      identityStore: identities, sessionStore: sessions, refreshStore: refresh, tokenService: tokens }) },
  ];
  if (availability.google) providers.push(
    { provide: GoogleCodeExchange, useFactory: () => new GoogleCodeExchange() },
    { provide: GOOGLE_AUTH_FLOW, inject: [OAuthStateService, GoogleCodeExchange, GoogleLoginSession], useFactory: (states, exchange, session) => {
    const config = loadGoogleOAuthConfig(process.env);
    return new GoogleAuthFlow({ callbackUrl: config.callbackUrl, webOrigin: config.webOrigin, clientId: process.env.GOOGLE_CLIENT_ID!, stateService: states, codeExchange: exchange, loginSession: session });
  } },
  );
  if (availability.microsoft) providers.push(
    { provide: MicrosoftCodeExchange, useFactory: () => new MicrosoftCodeExchange(loadMicrosoftOAuthConfig(process.env)) },
    { provide: MICROSOFT_AUTH_FLOW, inject: [OAuthStateService, MicrosoftCodeExchange, GoogleLoginSession], useFactory: (states, exchange, session) => {
    const config = loadMicrosoftOAuthConfig(process.env);
    return new MicrosoftAuthFlow({ ...config, stateService: states, codeExchange: exchange, loginSession: session });
  } },
  );
  return providers;
}

export function externalProviderAvailability(env: NodeJS.ProcessEnv = process.env) {
  let google = false;
  let microsoft = false;
  let signingKeyAvailable = false;
  try { loadTokenSigningKey(env); signingKeyAvailable = true; } catch { /* OAuth routes require the same session signing key as password login. */ }
  try {
    const config = loadGoogleOAuthConfig(env);
    const clientId = env.GOOGLE_CLIENT_ID;
    google = signingKeyAvailable && typeof clientId === 'string' && /^[\x21-\x7e]{1,255}$/.test(clientId) &&
      typeof env.GOOGLE_CLIENT_SECRET === 'string' && !!env.GOOGLE_CLIENT_SECRET.trim() &&
      new URL(config.callbackUrl).hostname === new URL(config.webOrigin).hostname &&
      new URL(config.callbackUrl).protocol === new URL(config.webOrigin).protocol;
  } catch { /* Missing or malformed values keep provider disabled. */ }
  try { loadMicrosoftOAuthConfig(env); microsoft = signingKeyAvailable; } catch { /* Missing or malformed values keep provider disabled. */ }
  return { google, microsoft };
}
