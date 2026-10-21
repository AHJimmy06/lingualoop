import { randomBytes } from 'node:crypto';
import { createGoogleBrowserPolicy } from './google-browser-policy';
import type { OAuthStateService } from './oauth-state.service';
import type { GoogleLoginSession } from './google-login-session';
import { MicrosoftCodeExchange } from './microsoft-code-exchange';

const AUTHORIZATION_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const NONCE_COOKIE = 'lingualoop-microsoft-nonce';
const SAFE_ERROR = 'Microsoft login could not be completed.';

export interface MicrosoftAuthCallback { cookieHeader?: unknown; state?: unknown; code?: unknown; error?: unknown }

export class MicrosoftAuthFlow {
  private readonly policy: ReturnType<typeof createGoogleBrowserPolicy>;
  constructor(private readonly dependencies: {
    callbackUrl: string;
    webOrigin: string;
    clientId: string;
    stateService: Pick<OAuthStateService, 'createState' | 'consumeState'>;
    codeExchange: Pick<MicrosoftCodeExchange, 'exchange'>;
    loginSession: Pick<GoogleLoginSession, 'issue'>;
    now?: () => number;
  }) {
    const callback = new URL(dependencies.callbackUrl);
    const policyCallback = new URL(dependencies.webOrigin);
    policyCallback.pathname = '/auth/google/callback';
    this.policy = createGoogleBrowserPolicy({
      callbackUrl: policyCallback.toString(), webOrigin: dependencies.webOrigin,
      stateCookieName: 'lingualoop-microsoft-oauth-state',
      consumeState: state => dependencies.stateService.consumeState(state, 'microsoft'),
    });
    if (callback.pathname !== '/auth/microsoft/callback' || callback.search || callback.hash ||
        callback.hostname !== new URL(dependencies.webOrigin).hostname || callback.protocol !== new URL(dependencies.webOrigin).protocol ||
        !/^[\x21-\x7e]{1,255}$/.test(dependencies.clientId)) throw new TypeError('Invalid Microsoft OAuth configuration.');
  }

  async begin(): Promise<{ authorizationUrl: string; stateCookie: string; nonceCookie: string }> {
    try {
      const state = await this.dependencies.stateService.createState({ provider: 'microsoft' });
      const nonce = randomBytes(32).toString('base64url');
      const auth = new URL(AUTHORIZATION_ENDPOINT);
      auth.searchParams.set('client_id', this.dependencies.clientId);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('response_mode', 'query');
      auth.searchParams.set('redirect_uri', this.dependencies.callbackUrl);
      auth.searchParams.set('scope', 'openid profile email User.Read');
      auth.searchParams.set('state', state);
      auth.searchParams.set('nonce', nonce);
      return { authorizationUrl: auth.toString(), stateCookie: this.policy.stateCookie(state), nonceCookie: this.nonceCookie(nonce) };
    } catch { throw new Error(SAFE_ERROR); }
  }

  clearStateCookie(): string { return this.policy.clearStateCookie(); }
  clearNonceCookie(): string { return this.nonceCookie('', true); }
  failureRedirectUrl(): string { return `${this.dependencies.webOrigin}/login?status=oauth-failed`; }

  async finish(callback: MicrosoftAuthCallback): Promise<{ redirectUrl: string; refreshCookie: string; stateCookie: string; nonceCookie: string }> {
    try {
      await this.policy.consumeCallbackState(callback?.cookieHeader, callback?.state);
      if (callback.error !== undefined || typeof callback.code !== 'string' || callback.code.length < 1 || callback.code.length > 2048) throw new Error();
      const nonce = this.readNonce(callback.cookieHeader);
      const token = await this.dependencies.codeExchange.exchange(callback.code);
      const session = await this.dependencies.loginSession.issue(token.idToken, nonce, token.accessToken);
      const now = this.dependencies.now?.() ?? Date.now();
      return { redirectUrl: this.dependencies.webOrigin, refreshCookie: this.policy.refreshCookie(session.refreshCredential, session.expiresAtMs, now), stateCookie: this.policy.clearStateCookie(), nonceCookie: this.clearNonceCookie() };
    } catch { throw new Error(SAFE_ERROR); }
  }

  private nonceCookie(value: string, clear = false): string {
    const secure = new URL(this.dependencies.callbackUrl).protocol === 'https:';
    const name = secure ? `__Host-${NONCE_COOKIE}` : NONCE_COOKIE;
    return `${name}=${value}; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax; Max-Age=${clear ? 0 : 300}`;
  }

  private readNonce(header: unknown): string {
    if (typeof header !== 'string' || header.length > 8192) throw new Error();
    const secure = new URL(this.dependencies.callbackUrl).protocol === 'https:';
    const name = secure ? `__Host-${NONCE_COOKIE}` : NONCE_COOKIE;
    const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
    if (values.length !== 1) throw new Error();
    const nonce = values[0].slice(name.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error();
    return nonce;
  }
}
