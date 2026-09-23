import { createHash, randomBytes } from 'node:crypto';

export const ABSOLUTE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_ERROR = 'Invalid refresh credential.';

export interface ParsedRefreshCredential {
  sessionUuid: string;
  hash: string;
}

/** Computes the fixed absolute session expiry; refreshes must never extend it. */
export function absoluteSessionExpiry(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new RangeError('Invalid session timestamp.');
  const expiry = nowMs + ABSOLUTE_SESSION_TTL_MS;
  if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new RangeError('Invalid session timestamp.');
  return expiry;
}

/** Creates a bearer credential. Callers must keep the returned credential out of logs and storage. */
export function createRefreshCredential(sessionUuid: string): { credential: string; hash: string } {
  if (typeof sessionUuid !== 'string' || !UUID_PATTERN.test(sessionUuid)) throw new Error(CREDENTIAL_ERROR);
  const canonicalSessionUuid = sessionUuid.toLowerCase();
  const secret = randomBytes(32).toString('base64url');
  const credential = `${canonicalSessionUuid}.${secret}`;
  return { credential, hash: hashCredential(credential) };
}

/** Parses the bearer credential without returning its secret. */
export function parseRefreshCredential(token: string): ParsedRefreshCredential {
  if (typeof token !== 'string') throw new Error(CREDENTIAL_ERROR);
  const separator = token.indexOf('.');
  if (separator !== 36 || token.length !== 80 || token.indexOf('.', separator + 1) !== -1) {
    throw new Error(CREDENTIAL_ERROR);
  }
  const sessionUuid = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!CANONICAL_UUID_PATTERN.test(sessionUuid) || !SECRET_PATTERN.test(secret)) throw new Error(CREDENTIAL_ERROR);

  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== secret) throw new Error(CREDENTIAL_ERROR);
  return { sessionUuid, hash: hashCredential(token) };
}

function hashCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}
