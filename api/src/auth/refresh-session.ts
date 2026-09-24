import { createRefreshCredential, parseRefreshCredential } from './refresh-credential';
import { RefreshStore } from './refresh-store';
import { SessionStore } from './session-store';
import { LinguaLoopTokenService } from './lingualoop-token.service';

const SESSION_ERROR_MESSAGE = 'Session operation could not be completed.';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RefreshSessionError extends Error {
  constructor() {
    super(SESSION_ERROR_MESSAGE);
    this.name = 'RefreshSessionError';
  }
}

export interface RefreshSessionResult {
  accessToken: string;
  refreshCredential: string;
  expiresAtMs: number;
  /** Best-effort revoke using only the owner returned by the successful atomic rotation. */
  compensateDeliveryFailure(): Promise<void>;
}

/** Owner/session binding must come from a verified access token, never from refresh-credential claims. */
export interface VerifiedSessionBinding {
  ownerId: string;
  sessionId: string;
}

export interface RefreshSessionDependencies {
  refreshStore: Pick<RefreshStore, 'rotate'>;
  sessionStore: Pick<SessionStore, 'revokeSession'>;
  tokenService: Pick<LinguaLoopTokenService, 'issue'>;
  now?: () => number;
  createRefreshCredential?: typeof createRefreshCredential;
}

/** Pure internal refresh/logout orchestration; HTTP and cookie policy belong to the caller. */
export class RefreshSession {
  private readonly now: () => number;
  private readonly makeRefreshCredential: typeof createRefreshCredential;

  constructor(private readonly dependencies: RefreshSessionDependencies) {
    if (!dependencies || typeof dependencies !== 'object') throw new TypeError('Session dependencies are required.');
    this.now = dependencies.now ?? Date.now;
    this.makeRefreshCredential = dependencies.createRefreshCredential ?? createRefreshCredential;
    if (typeof this.now !== 'function' || typeof this.makeRefreshCredential !== 'function') {
      throw new TypeError('Session clock and credential generator are required.');
    }
  }

  async refresh(credential: string): Promise<RefreshSessionResult> {
    try {
      const parsed = parseRefreshCredential(credential);
      const next = this.makeRefreshCredential(parsed.sessionUuid);
      if (!next || typeof next.credential !== 'string' || typeof next.hash !== 'string' ||
          next.credential === credential || next.credential.length === 0 || next.hash.length === 0) {
        throw new Error(SESSION_ERROR_MESSAGE);
      }
      const nowMs = this.now();
      const rotated = await this.dependencies.refreshStore.rotate(parsed.sessionUuid, parsed.hash, next.hash, nowMs);
      if (rotated.status !== 'rotated') throw new Error(SESSION_ERROR_MESSAGE);

      try {
        const accessToken = await this.dependencies.tokenService.issue({
          issuer: rotated.issuer,
          subject: rotated.subject,
          sessionId: parsed.sessionUuid,
        });
        if (typeof accessToken !== 'string' || accessToken.length === 0) throw new Error(SESSION_ERROR_MESSAGE);
        let compensation: Promise<void> | undefined;
        return {
          accessToken,
          refreshCredential: next.credential,
          // Keep the database's original absolute expiry; never calculate a new sliding expiry.
          expiresAtMs: rotated.expiresAtMs,
          compensateDeliveryFailure: () => {
            compensation ??= (async () => {
              try {
                await this.dependencies.sessionStore.revokeSession(rotated.ownerId, parsed.sessionUuid, this.now());
              } catch {
                // Delivery compensation is best-effort and must not expose owner/store details.
              }
            })();
            return compensation;
          },
        };
      } catch {
        // The new hash is already current. Revoking the bound session makes that rotated credential unusable.
        try {
          await this.dependencies.sessionStore.revokeSession(rotated.ownerId, parsed.sessionUuid, this.now());
        } catch {
          // Preserve a generic error; compensation failure cannot be safely exposed to the caller.
        }
        throw new Error(SESSION_ERROR_MESSAGE);
      }
    } catch {
      throw new RefreshSessionError();
    }
  }

  /** Logout only consumes the already verified owner/session binding supplied by auth middleware. */
  async logout(binding: VerifiedSessionBinding): Promise<void> {
    try {
      if (!binding || typeof binding !== 'object' || typeof binding.ownerId !== 'string' ||
          !UUID_PATTERN.test(binding.ownerId) || typeof binding.sessionId !== 'string' ||
          !UUID_PATTERN.test(binding.sessionId)) throw new Error(SESSION_ERROR_MESSAGE);
      await this.dependencies.sessionStore.revokeSession(binding.ownerId, binding.sessionId, this.now());
    } catch {
      throw new RefreshSessionError();
    }
  }
}
