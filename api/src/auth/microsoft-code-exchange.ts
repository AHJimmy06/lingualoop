const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MAX_CODE = 2048;
export class MicrosoftCodeExchangeError extends Error { constructor() { super('Microsoft authorization-code exchange failed.'); } }

export class MicrosoftCodeExchange {
  constructor(private readonly config: { clientId: string; clientSecret: string; callbackUrl: string }, private readonly request: typeof fetch = fetch) {
    if (!config.clientId || !config.clientSecret || !config.callbackUrl) throw new TypeError('Microsoft OAuth settings are required.');
  }
  async exchange(code: string): Promise<{ idToken: string; accessToken: string }> {
    if (typeof code !== 'string' || !code.length || code.length > MAX_CODE || code.trim() !== code) throw new MicrosoftCodeExchangeError();
    try {
      const body = new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret,
        code, redirect_uri: this.config.callbackUrl, grant_type: 'authorization_code', scope: 'openid profile email User.Read' });
      const response = await this.request(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      const tokens: unknown = await response.json();
      if (!tokens || typeof tokens !== 'object' || !('id_token' in tokens) || typeof tokens.id_token !== 'string' || tokens.id_token.length > 16_384 ||
          !('access_token' in tokens) || typeof tokens.access_token !== 'string' || tokens.access_token.length > 8192) throw new Error();
      return { idToken: tokens.id_token, accessToken: tokens.access_token };
    } catch { throw new MicrosoftCodeExchangeError(); }
  }
}
