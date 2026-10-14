import { AccountStore } from './account-store';
import { createRefreshCredential, absoluteSessionExpiry } from './refresh-credential';
import { SessionStore } from './session-store';
import { RefreshStore } from './refresh-store';
import { LinguaLoopTokenService } from './lingualoop-token.service';

export const PASSWORD_LOGIN_SESSION = Symbol('PASSWORD_LOGIN_SESSION');
export class InvalidCredentialsError extends Error { constructor() { super('Invalid credentials.'); } }
export class PasswordLoginSession {
  constructor(private readonly accounts: Pick<AccountStore, 'authenticate'>,
    private readonly sessions: Pick<SessionStore, 'createSession' | 'revokeSession'>,
    private readonly refresh: Pick<RefreshStore, 'initialize'>,
    private readonly tokens: Pick<LinguaLoopTokenService, 'issue'>) {}

  async issue(email: string, password: string) {
    const ownerId = await this.accounts.authenticate(email, password);
    if (!ownerId) throw new InvalidCredentialsError();
    const nowMs = Date.now();
    const expiresAtMs = absoluteSessionExpiry(nowMs);
    const sessionId = await this.sessions.createSession(ownerId, expiresAtMs);
    let compensation: Promise<void> | undefined;
    const compensateDeliveryFailure = () => {
      compensation ??= (async () => {
        try { await this.sessions.revokeSession(ownerId, sessionId, Date.now()); } catch { /* Never deliver credentials on failure. */ }
      })();
      return compensation;
    };
    try {
      const credential = createRefreshCredential(sessionId);
      if (!await this.refresh.initialize(ownerId, sessionId, credential.hash, nowMs)) throw new Error();
      // Signing remains part of compensated issuance even though login exposes only its cookie.
      const accessToken = await this.tokens.issue({ issuer: 'local', subject: ownerId, sessionId });
      if (typeof accessToken !== 'string' || !accessToken) throw new Error();
      return { refreshCredential: credential.credential, expiresAtMs, compensateDeliveryFailure };
    } catch {
      await compensateDeliveryFailure();
      throw new Error('Login service unavailable.');
    }
  }
}
