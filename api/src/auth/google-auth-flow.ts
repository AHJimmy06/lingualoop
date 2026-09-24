import { createGoogleBrowserPolicy } from './google-browser-policy';
import { loadGoogleOAuthConfig } from './google-oauth.config';
import type { GoogleCodeExchange } from './google-code-exchange';
import type { GoogleLoginSession } from './google-login-session';
import type { OAuthStateService } from './oauth-state.service';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GENERIC_FAILURE = 'Google login could not be completed.';

export class GoogleAuthFlowError extends Error {
  constructor() {
    super(GENERIC_FAILURE);
    this.name = 'GoogleAuthFlowError';
  }
}

export interface GoogleAuthCallback {
  cookieHeader?: unknown;
  state?: unknown;
  code?: unknown;
  error?: unknown;
}

export interface GoogleAuthFlowDependencies {
  callbackUrl: string;
  webOrigin: string;
  clientId: string;
  stateService: Pick<OAuthStateService, 'createState' | 'consumeState'>;
  codeExchange: Pick<GoogleCodeExchange, 'exchange'>;
  loginSession: Pick<GoogleLoginSession, 'issue'>;
  now?: () => number;
}

/** Internal OAuth orchestration only: no HTTP, Nest route, logging, or provider network wiring. */
export class GoogleAuthFlow {
  private readonly policy: ReturnType<typeof createGoogleBrowserPolicy>;
  private readonly clientId: string;
  private readonly now: () => number;

  constructor(private readonly dependencies: GoogleAuthFlowDependencies) {
    if (!dependencies || typeof dependencies !== 'object') throw new TypeError('Explicit Google login dependencies are required.');
    const config = loadGoogleOAuthConfig({
      GOOGLE_CALLBACK_URL: dependencies.callbackUrl,
      LINGUALOOP_WEB_ORIGIN: dependencies.webOrigin,
    });
    if (typeof dependencies.clientId !== 'string' || !/^[\x21-\x7E]{1,255}$/.test(dependencies.clientId)) {
      throw new TypeError('GOOGLE_CLIENT_ID must be explicitly configured.');
    }
    if (!dependencies.stateService || typeof dependencies.stateService.createState !== 'function' ||
        typeof dependencies.stateService.consumeState !== 'function' ||
        !dependencies.codeExchange || typeof dependencies.codeExchange.exchange !== 'function' ||
        !dependencies.loginSession || typeof dependencies.loginSession.issue !== 'function') {
      throw new TypeError('Google login dependencies are incomplete.');
    }
    this.policy = createGoogleBrowserPolicy({
      callbackUrl: config.callbackUrl,
      webOrigin: config.webOrigin,
      consumeState: (state) => dependencies.stateService.consumeState(state, 'google'),
    });
    this.clientId = dependencies.clientId;
    this.now = dependencies.now ?? Date.now;
    if (typeof this.now !== 'function') throw new TypeError('A login clock is required.');
  }

  async begin(): Promise<{ authorizationUrl: string; stateCookie: string }> {
    try {
      const state = await this.dependencies.stateService.createState({ provider: 'google' });
      const authorization = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      authorization.searchParams.set('response_type', 'code');
      authorization.searchParams.set('client_id', this.clientId);
      authorization.searchParams.set('redirect_uri', this.dependencies.callbackUrl);
      authorization.searchParams.set('scope', 'openid');
      authorization.searchParams.set('state', state);
      return { authorizationUrl: authorization.toString(), stateCookie: this.policy.stateCookie(state) };
    } catch {
      throw new GoogleAuthFlowError();
    }
  }

  /** The caller can use clearStateCookie() on every callback outcome, including thrown failures. */
  clearStateCookie(): string {
    return this.policy.clearStateCookie();
  }

  async finish(callback: GoogleAuthCallback): Promise<{
    redirectUrl: string;
    refreshCookie: string;
    stateCookie: string;
  }> {
    try {
      if (!callback || typeof callback !== 'object' || Array.isArray(callback)) throw new Error();
      await this.policy.consumeCallbackState(callback.cookieHeader, callback.state);
      if (callback.error !== undefined || typeof callback.code !== 'string' || callback.code.length === 0) {
        throw new Error();
      }
      const exchanged = await this.dependencies.codeExchange.exchange(callback.code);
      const session = await this.dependencies.loginSession.issue(exchanged.idToken);
      return {
        redirectUrl: this.dependencies.webOrigin,
        refreshCookie: this.policy.refreshCookie(session.refreshCredential, session.expiresAtMs, this.now()),
        stateCookie: this.policy.clearStateCookie(),
      };
    } catch {
      throw new GoogleAuthFlowError();
    }
  }
}
