import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface OAuthStateRecord {
  expiresAt: number;
  provider?: string;
}

/** Store implementations must atomically return and remove a record for its hash. */
export interface OAuthStateStore {
  put(hash: string, record: OAuthStateRecord): Promise<void>;
  consume(hash: string): Promise<OAuthStateRecord | null>;
}

export interface CreateOAuthStateOptions {
  ttlMs?: number;
  provider?: string;
}

export class InvalidOAuthStateError extends Error {
  constructor() {
    super('OAuth state is invalid or expired.');
    this.name = 'InvalidOAuthStateError';
  }
}

export class OAuthStateService {
  constructor(
    private readonly store: OAuthStateStore,
    private readonly now: () => number = Date.now,
  ) {
    if (!store || typeof store.put !== 'function' || typeof store.consume !== 'function') {
      throw new TypeError('An atomic OAuth state store is required.');
    }
    if (typeof now !== 'function') {
      throw new TypeError('A clock function is required.');
    }
  }

  async createState(options: CreateOAuthStateOptions = {}): Promise<string> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new RangeError('Invalid OAuth state options.');
    }
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_TTL_MS) {
      throw new RangeError(`ttlMs must be a positive safe integer no greater than ${DEFAULT_TTL_MS}.`);
    }
    if (options.provider !== undefined &&
        (typeof options.provider !== 'string' || !PROVIDER_PATTERN.test(options.provider))) {
      throw new RangeError('provider must be a non-empty provider marker.');
    }

    const now = this.now();
    const expiresAt = now + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new RangeError('OAuth state expiry must be a finite safe integer.');
    }

    const state = randomBytes(32).toString('base64url');
    const hash = this.hash(state);
    await this.store.put(hash, {
      expiresAt,
      provider: options.provider,
    });
    return state;
  }

  async consumeState(state: string, provider?: string): Promise<void> {
    if (typeof state !== 'string' || !STATE_PATTERN.test(state)) {
      throw new InvalidOAuthStateError();
    }
    if (provider !== undefined &&
        (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider))) {
      throw new InvalidOAuthStateError();
    }

    const record = await this.store.consume(this.hash(state));
    if (!record || !Number.isFinite(record.expiresAt) || this.now() >= record.expiresAt ||
        record.provider !== provider) {
      throw new InvalidOAuthStateError();
    }
  }

  private hash(state: string): string {
    return createHash('sha256').update(state).digest('hex');
  }
}
