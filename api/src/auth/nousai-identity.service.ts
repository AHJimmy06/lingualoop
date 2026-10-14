export interface VerifiedIdentity {
  issuer: 'nousai';
  subject: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class InvalidCredentialError extends Error {
  constructor() {
    super('The NousAI credential is invalid or inactive.');
    this.name = 'InvalidCredentialError';
  }
}

export class IdentityServiceUnavailableError extends Error {
  constructor() {
    super('The NousAI identity service is unavailable or returned an invalid response.');
    this.name = 'IdentityServiceUnavailableError';
  }
}

const PROFILE_TIMEOUT_MS = 5_000;
const MAX_BEARER_TOKEN_LENGTH = 8_192;
const COMPACT_JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class NousAIIdentityService {
  private readonly profileUrl: URL;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    profileUrl: string | undefined = process.env.LINGUALOOP_AUTH_PROFILE_URL,
    fetcher: FetchLike = globalThis.fetch,
    timeoutMs = PROFILE_TIMEOUT_MS,
  ) {
    this.profileUrl = this.parseProfileUrl(profileUrl);
    if (typeof fetcher !== 'function') {
      throw new IdentityServiceUnavailableError();
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > PROFILE_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must be between 1 and ${PROFILE_TIMEOUT_MS}.`);
    }
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  async verifyBearerToken(token: string): Promise<VerifiedIdentity> {
    if (
      typeof token !== 'string' ||
      token.length > MAX_BEARER_TOKEN_LENGTH ||
      !COMPACT_JWT_PATTERN.test(token)
    ) {
      throw new InvalidCredentialError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.profileUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new InvalidCredentialError();
      }
      if (response.status !== 200) {
        throw new IdentityServiceUnavailableError();
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new IdentityServiceUnavailableError();
      }

      if (!this.isProfile(body)) {
        throw new IdentityServiceUnavailableError();
      }
      if (!body.data.isActive) {
        throw new InvalidCredentialError();
      }

      return { issuer: 'nousai', subject: String(body.data.id) };
    } catch (error) {
      if (error instanceof InvalidCredentialError || error instanceof IdentityServiceUnavailableError) {
        throw error;
      }
      throw new IdentityServiceUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseProfileUrl(value: string | undefined): URL {
    if (!value || value !== value.trim() || !/^https?:\/\//i.test(value)) {
      throw new IdentityServiceUnavailableError();
    }

    try {
      const url = new URL(value);
      const loopbackHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHost)) ||
        url.pathname !== '/api/auth/profile' ||
        value.includes('?') ||
        value.includes('#') ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        throw new Error('Invalid profile URL.');
      }
      return url;
    } catch {
      throw new IdentityServiceUnavailableError();
    }
  }

  private isProfile(value: unknown): value is {
    success: true;
    data: { id: number; isActive: boolean };
  } {
    if (typeof value !== 'object' || value === null) return false;
    const envelope = value as Record<string, unknown>;
    if (envelope.success !== true || typeof envelope.data !== 'object' || envelope.data === null) {
      return false;
    }
    const data = envelope.data as Record<string, unknown>;
    return typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0 && typeof data.isActive === 'boolean';
  }
}
