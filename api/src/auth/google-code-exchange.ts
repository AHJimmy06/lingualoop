import { OAuth2Client } from 'google-auth-library';
import { loadGoogleOAuthConfig } from './google-oauth.config';

const MAX_AUTHORIZATION_CODE_LENGTH = 2_048;
const MAX_ID_TOKEN_LENGTH = 16_384;

export interface GoogleTokenResponse {
  tokens?: {
    id_token?: unknown;
  };
}

/** An exchange seam for offline tests or a separately configured OAuth transport. */
export type GoogleAuthorizationCodeExchanger = (
  code: string,
  redirectUri: string,
) => Promise<GoogleTokenResponse>;

export class GoogleCodeExchangeError extends Error {
  constructor() {
    super('Google authorization-code exchange failed.');
    this.name = 'GoogleCodeExchangeError';
  }
}

/** Exchanges an authorization code only; it does not establish or verify identity. */
export class GoogleCodeExchange {
  private readonly redirectUri: string;
  private readonly exchangeWithGoogle: GoogleAuthorizationCodeExchanger;

  constructor(options: {
    env?: NodeJS.ProcessEnv;
    exchanger?: GoogleAuthorizationCodeExchanger;
  } = {}) {
    const env = options.env ?? process.env;
    const config = loadGoogleOAuthConfig(env);
    this.redirectUri = config.callbackUrl;

    if (options.exchanger) {
      this.exchangeWithGoogle = options.exchanger;
      return;
    }

    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    if (typeof clientId !== 'string' || clientId.length === 0 ||
        typeof clientSecret !== 'string' || clientSecret.length === 0) {
      throw new TypeError('Google OAuth client credentials must be explicitly configured.');
    }

    const client = new OAuth2Client(clientId, clientSecret, this.redirectUri);
    this.exchangeWithGoogle = async (code) => client.getToken(code);
  }

  /** Returns an untrusted ID token for a separate GoogleIdentityService.verify call. */
  async exchange(code: string): Promise<{ idToken: string }> {
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX_AUTHORIZATION_CODE_LENGTH ||
        code.trim() !== code || /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(code)) {
      throw new GoogleCodeExchangeError();
    }

    try {
      const response = await this.exchangeWithGoogle(code, this.redirectUri);
      const idToken = response?.tokens?.id_token;
      if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_ID_TOKEN_LENGTH) {
        throw new GoogleCodeExchangeError();
      }
      return { idToken };
    } catch {
      // Never expose provider errors, which may contain the submitted code or credentials.
      throw new GoogleCodeExchangeError();
    }
  }
}
