import { normalizeEmail } from './account-role';
import { GoogleIdentityService } from './google-identity.service';
import { IdentityStore, type VerifiedIdentity } from './identity-store';
import { LinguaLoopTokenService } from './lingualoop-token.service';
import { createRefreshCredential, absoluteSessionExpiry } from './refresh-credential';
import { RefreshStore } from './refresh-store';
import { SessionStore } from './session-store';

const LOGIN_ERROR_MESSAGE = 'Google login could not be completed.';
const MAX_ID_TOKEN_LENGTH = 16_384;
const MAX_SUBJECT_BYTES = 512;

export class GoogleLoginSessionError extends Error {
  constructor() {
    super(LOGIN_ERROR_MESSAGE);
    this.name = 'GoogleLoginSessionError';
  }
}

export interface GoogleLoginSessionResult {
  accessToken: string;
  refreshCredential: string;
  expiresAtMs: number;
}

export interface GoogleLoginSessionDependencies {
  googleIdentityService: { verify(idToken: string, nonce?: string, accessToken?: string): Promise<VerifiedIdentity> };
  identityStore: Pick<IdentityStore, 'linkExternalIdentity'>;
  sessionStore: Pick<SessionStore, 'createSession' | 'revokeSession'>;
  refreshStore: Pick<RefreshStore, 'initialize'>;
  tokenService: Pick<LinguaLoopTokenService, 'issue'>;
  now?: () => number;
  createRefreshCredential?: typeof createRefreshCredential;
}

/** Verifies an untrusted Google ID token, then creates one compensated, absolute-expiry session. */
export class GoogleLoginSession {
  private readonly now: () => number;
  private readonly makeRefreshCredential: typeof createRefreshCredential;

  constructor(private readonly dependencies: GoogleLoginSessionDependencies) {
    if (!dependencies || typeof dependencies !== 'object') throw new TypeError('Login dependencies are required.');
    this.now = dependencies.now ?? Date.now;
    this.makeRefreshCredential = dependencies.createRefreshCredential ?? createRefreshCredential;
    if (typeof this.now !== 'function' || typeof this.makeRefreshCredential !== 'function') {
      throw new TypeError('Login clock and credential generator are required.');
    }
  }

  async issue(idToken: string, nonce?: string, accessToken?: string): Promise<GoogleLoginSessionResult> {
    if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_ID_TOKEN_LENGTH) {
      throw new GoogleLoginSessionError();
    }

    let identity: VerifiedIdentity;
    try {
      // No store or credential operation may happen until the cryptographic verifier accepts this token.
      identity = await this.dependencies.googleIdentityService.verify(idToken, nonce, accessToken);
      this.validateVerifiedIdentity(identity);
    } catch {
      throw new GoogleLoginSessionError();
    }

    let ownerId: string;
    let nowMs: number;
    let expiresAtMs: number;
    try {
      ownerId = await this.dependencies.identityStore.linkExternalIdentity(identity);
      nowMs = this.now();
      expiresAtMs = absoluteSessionExpiry(nowMs);
    } catch {
      throw new GoogleLoginSessionError();
    }

    let sessionId: string;
    try {
      sessionId = await this.dependencies.sessionStore.createSession(ownerId, expiresAtMs);
    } catch {
      throw new GoogleLoginSessionError();
    }

    try {
      const refresh = this.makeRefreshCredential(sessionId);
      if (!refresh || typeof refresh.credential !== 'string' || typeof refresh.hash !== 'string') {
        throw new Error('Invalid generated refresh credential.');
      }
      if (!await this.dependencies.refreshStore.initialize(ownerId, sessionId, refresh.hash, nowMs)) {
        throw new Error('Refresh initialization failed.');
      }
      const accessToken = await this.dependencies.tokenService.issue({
        // App sessions bind to the provisioned LinguaLoop account, not the external IdP subject.
        issuer: 'local',
        subject: ownerId,
        sessionId,
      });
      if (typeof accessToken !== 'string' || accessToken.length === 0) throw new Error('Token issuance failed.');
      return { accessToken, refreshCredential: refresh.credential, expiresAtMs };
    } catch {
      try {
        await this.dependencies.sessionStore.revokeSession(ownerId, sessionId, this.now());
      } catch {
        // Keep the generic rejection; in particular, never return any credential if rollback fails.
      }
      throw new GoogleLoginSessionError();
    }
  }

  private validateVerifiedIdentity(identity: VerifiedIdentity): void {
    if (!identity || typeof identity !== 'object' || !['google', 'microsoft'].includes(identity.issuer) ||
        typeof identity.subject !== 'string' || identity.subject.length === 0 ||
        Buffer.byteLength(identity.subject, 'utf8') > MAX_SUBJECT_BYTES ||
        Buffer.from(identity.subject, 'utf8').toString('utf8') !== identity.subject ||
        identity.subject.normalize('NFC') !== identity.subject ||
        /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(identity.subject) ||
        normalizeEmail(identity.email) !== identity.email) {
      throw new Error(LOGIN_ERROR_MESSAGE);
    }
  }
}
