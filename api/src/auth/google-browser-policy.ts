import { timingSafeEqual } from 'node:crypto';
import { loadGoogleOAuthConfig } from './google-oauth.config';

const STATE_TTL_SECONDS = 5 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TTL_MILLISECONDS = REFRESH_TTL_SECONDS * 1000;
const MAX_DATE_MILLISECONDS = 8.64e15;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
export const GOOGLE_BROWSER_POLICY = Symbol('GOOGLE_BROWSER_POLICY');
const GENERIC_FAILURE = 'Google login could not be completed.';

export class GoogleBrowserPolicyError extends Error {
  constructor() {
    super(GENERIC_FAILURE);
    this.name = 'GoogleBrowserPolicyError';
  }
}

export interface GoogleBrowserPolicyOptions {
  callbackUrl: string;
  webOrigin: string;
  /** Must atomically consume the matching state in the backing store. */
  consumeState?: (state: string) => Promise<unknown>;
}

/** Pure cookie, callback-state, and Origin policy; deliberately not wired to Nest or routes. */
export function createGoogleBrowserPolicy(options: GoogleBrowserPolicyOptions) {
  if (!options || typeof options !== 'object') throw new TypeError('Explicit Google OAuth configuration is required.');

  // Revalidate at this boundary instead of trusting a structurally forged TypeScript object.
  const config = loadGoogleOAuthConfig({
    GOOGLE_CALLBACK_URL: options.callbackUrl,
    LINGUALOOP_WEB_ORIGIN: options.webOrigin,
  });
  const callback = new URL(config.callbackUrl);
  const web = new URL(config.webOrigin);
  if (callback.hostname !== web.hostname) {
    throw new TypeError('Google callback and web origin must use the same hostname.');
  }
  if (callback.protocol !== web.protocol) {
    throw new TypeError('Google callback and web origin must use the same scheme.');
  }

  const secure = callback.protocol === 'https:';
  const stateName = secure ? '__Host-lingualoop-oauth-state' : 'lingualoop-oauth-state';
  const refreshName = secure ? '__Host-lingualoop-refresh' : 'lingualoop-refresh';
  const cookieAttributes = `Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax`;

  return {
    stateCookie(state: string): string {
      if (!isValidState(state)) throw new TypeError('OAuth state must be a 43-character base64url value.');
      return `${stateName}=${state}; ${cookieAttributes}; Max-Age=${STATE_TTL_SECONDS}`;
    },

    refreshCookie(credential: string, expiresAtMs: number, nowMs: number): string {
      if (typeof credential !== 'string' || !COOKIE_VALUE_PATTERN.test(credential)) {
        throw new TypeError('Refresh credential is not a safe cookie value.');
      }
      if (!isValidTimestamp(expiresAtMs) || !isValidTimestamp(nowMs)
        || expiresAtMs <= nowMs || expiresAtMs - nowMs > REFRESH_TTL_MILLISECONDS) {
        throw new TypeError('Refresh session expiration is invalid.');
      }
      const maxAgeSeconds = Math.floor((expiresAtMs - nowMs) / 1000);
      return `${refreshName}=${credential}; ${cookieAttributes}; Max-Age=${maxAgeSeconds}`;
    },

    clearStateCookie(): string {
      return `${stateName}=; ${cookieAttributes}; Max-Age=0`;
    },

    clearRefreshCookie(): string {
      return `${refreshName}=; ${cookieAttributes}; Max-Age=0`;
    },

    readRefreshCredential(cookieHeader: unknown): string {
      try {
        return readSingleCookie(cookieHeader, refreshName);
      } catch {
        throw new GoogleBrowserPolicyError();
      }
    },

    async consumeCallbackState(cookieHeader: unknown, callbackState: unknown): Promise<void> {
      try {
        if (!isValidState(callbackState)) throw new Error();
        const cookieState = readSingleCookie(cookieHeader, stateName);
        if (!isValidState(cookieState)) throw new Error();
        const expected = Buffer.from(callbackState, 'ascii');
        const supplied = Buffer.from(cookieState, 'ascii');
        if (!timingSafeEqual(expected, supplied)) throw new Error();
        if (typeof options.consumeState !== 'function') throw new Error();
        // The database's atomic consume is reached only after syntactic and constant-time comparison.
        await options.consumeState(callbackState);
      } catch {
        throw new GoogleBrowserPolicyError();
      }
    },

    /** Exact configured Origin only: ports matter, and Host is never a fallback. */
    isAllowedRefreshOrLogoutOrigin(origin: unknown): boolean {
      return typeof origin === 'string' && origin === config.webOrigin;
    },
  };
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && Math.abs(value) <= MAX_DATE_MILLISECONDS;
}

function isValidState(value: unknown): value is string {
  return typeof value === 'string' && STATE_PATTERN.test(value);
}

function readSingleCookie(header: unknown, expectedName: string): string {
  if (typeof header !== 'string' || header.length === 0) throw new Error();
  let found: string | undefined;
  for (const part of header.split(';')) {
    const segment = part.trim();
    const equals = segment.indexOf('=');
    if (equals <= 0) throw new Error();
    const name = segment.slice(0, equals);
    const value = segment.slice(equals + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !COOKIE_VALUE_PATTERN.test(value)) throw new Error();
    if (name === expectedName) {
      if (found !== undefined) throw new Error();
      found = value;
    }
  }
  if (found === undefined) throw new Error();
  return found;
}
