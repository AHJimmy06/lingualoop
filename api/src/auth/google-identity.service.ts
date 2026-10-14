import { OAuth2Client } from 'google-auth-library';
import { normalizeEmail } from './account-role';

const MAX_ID_TOKEN_LENGTH = 16_384;
const MAX_SUBJECT_BYTES = 512;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export interface GoogleIdTokenPayload {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

export type GoogleTicketVerifier = (
  idToken: string,
  audience: string,
) => Promise<GoogleIdTokenPayload | null>;

export interface GoogleIdentity {
  issuer: 'google';
  subject: string;
  email: string;
}

export class InvalidGoogleIdTokenError extends Error {
  constructor() {
    super('Google ID token is invalid.');
    this.name = 'InvalidGoogleIdTokenError';
  }
}

async function verifyGoogleTicket(
  idToken: string,
  audience: string,
): Promise<GoogleIdTokenPayload | null> {
  const ticket = await new OAuth2Client().verifyIdToken({ idToken, audience });
  return ticket.getPayload() ?? null;
}

/** Validates Google identity claims after google-auth-library verifies the ticket. */
export class GoogleIdentityService {
  constructor(
    private readonly expectedAudience: string,
    private readonly verifyTicket: GoogleTicketVerifier = verifyGoogleTicket,
    private readonly now: () => number = Date.now,
  ) {
    if (typeof expectedAudience !== 'string' || expectedAudience.trim().length === 0) {
      throw new TypeError('A Google ID-token audience is required.');
    }
    if (typeof verifyTicket !== 'function' || typeof now !== 'function') {
      throw new TypeError('A Google ticket verifier and clock are required.');
    }
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_ID_TOKEN_LENGTH) {
      throw new InvalidGoogleIdTokenError();
    }

    try {
      const payload = await this.verifyTicket(idToken, this.expectedAudience);
      if (!payload || typeof payload !== 'object') throw new InvalidGoogleIdTokenError();
      if (typeof payload.iss !== 'string' || !GOOGLE_ISSUERS.has(payload.iss)) {
        throw new InvalidGoogleIdTokenError();
      }
      const audiences = typeof payload.aud === 'string'
        ? [payload.aud]
        : Array.isArray(payload.aud) && payload.aud.every((value) => typeof value === 'string')
          ? payload.aud
          : [];
      if (!audiences.includes(this.expectedAudience)) throw new InvalidGoogleIdTokenError();
      if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) ||
          payload.exp <= Math.floor(this.now() / 1_000)) {
        throw new InvalidGoogleIdTokenError();
      }
      if (payload.email_verified !== true) throw new InvalidGoogleIdTokenError();
      const email = normalizeEmail(payload.email);
      const subject = payload.sub;
      if (typeof subject !== 'string' || subject.length === 0 ||
          Buffer.byteLength(subject, 'utf8') > MAX_SUBJECT_BYTES ||
          subject.trim() !== subject || /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(subject) ||
          Buffer.from(subject, 'utf8').toString('utf8') !== subject) {
        throw new InvalidGoogleIdTokenError();
      }
      return { issuer: 'google', subject, email };
    } catch {
      throw new InvalidGoogleIdTokenError();
    }
  }
}
