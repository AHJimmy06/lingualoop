export const GOOGLE_CALLBACK_PATH = '/auth/google/callback';

export interface GoogleOAuthConfig {
  callbackUrl: string;
  webOrigin: string;
}

/** Validates explicit Google callback and browser-origin settings without consulting request data. */
export function loadGoogleOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleOAuthConfig {
  const callbackUrl = env.GOOGLE_CALLBACK_URL;
  const webOrigin = env.LINGUALOOP_WEB_ORIGIN;

  if (typeof callbackUrl !== 'string' || callbackUrl.length === 0) {
    throw new TypeError('GOOGLE_CALLBACK_URL must be explicitly configured.');
  }
  if (typeof webOrigin !== 'string' || webOrigin.length === 0) {
    throw new TypeError('LINGUALOOP_WEB_ORIGIN must be explicitly configured.');
  }

  validateCallbackUrl(callbackUrl);
  validateWebOrigin(webOrigin);
  return { callbackUrl, webOrigin };
}

function validateCallbackUrl(value: string): void {
  const url = parseAbsoluteUrl(value, 'GOOGLE_CALLBACK_URL');
  if (url.href !== value) {
    throw new TypeError('GOOGLE_CALLBACK_URL must be an unambiguous canonical HTTP(S) URL.');
  }
  if (url.username || url.password) {
    throw new TypeError('GOOGLE_CALLBACK_URL must not contain credentials.');
  }
  if (url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new TypeError('GOOGLE_CALLBACK_URL must not contain a query or fragment.');
  }
  if (url.pathname.includes('%') || url.pathname.includes('\\') || url.pathname !== GOOGLE_CALLBACK_PATH) {
    throw new TypeError(`GOOGLE_CALLBACK_URL must use the exact ${GOOGLE_CALLBACK_PATH} path.`);
  }
  if (!isSecureOrLoopback(url)) {
    throw new TypeError('GOOGLE_CALLBACK_URL must use HTTPS except for loopback development.');
  }
}

function validateWebOrigin(value: string): void {
  const url = parseAbsoluteUrl(value, 'LINGUALOOP_WEB_ORIGIN');
  if (url.username || url.password) {
    throw new TypeError('LINGUALOOP_WEB_ORIGIN must not contain credentials.');
  }
  if (url.search || url.hash || value.includes('?') || value.includes('#') || url.pathname !== '/' || url.origin !== value) {
    throw new TypeError('LINGUALOOP_WEB_ORIGIN must be one origin without a path, query, or fragment.');
  }
  if (!isSecureOrLoopback(url)) {
    throw new TypeError('LINGUALOOP_WEB_ORIGIN must use HTTPS except for loopback development.');
  }
}

function parseAbsoluteUrl(value: string, setting: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${setting} must be an absolute URL.`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) {
    throw new TypeError(`${setting} must be an unambiguous canonical HTTP(S) URL.`);
  }
  return url;
}

function isSecureOrLoopback(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
