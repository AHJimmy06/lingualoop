export interface MicrosoftOAuthConfig { callbackUrl: string; webOrigin: string; clientId: string; clientSecret: string; }
export function loadMicrosoftOAuthConfig(env: NodeJS.ProcessEnv = process.env): MicrosoftOAuthConfig {
  const { MICROSOFT_CALLBACK_URL: callbackUrl, LINGUALOOP_WEB_ORIGIN: webOrigin,
    MICROSOFT_CLIENT_ID: clientId, MICROSOFT_CLIENT_SECRET: clientSecret } = env;
  if (!callbackUrl || !webOrigin || !clientId || !clientSecret) throw new TypeError('Microsoft OAuth is not configured.');
  const callback = new URL(callbackUrl); const web = new URL(webOrigin);
  if (callback.href !== callbackUrl || callback.pathname !== '/auth/microsoft/callback' || callback.search || callback.hash ||
      callback.hostname !== web.hostname || callback.protocol !== web.protocol || web.origin !== webOrigin || web.pathname !== '/' || web.search || web.hash ||
      !['https:', 'http:'].includes(callback.protocol) || (callback.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(callback.hostname)) ||
      !/^[\x21-\x7e]{1,255}$/.test(clientId) || !clientSecret.trim()) throw new TypeError('Microsoft OAuth configuration is invalid.');
  return { callbackUrl, webOrigin, clientId, clientSecret };
}
