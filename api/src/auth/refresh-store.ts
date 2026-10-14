import type { QueryExecutor, QueryResult } from './identity-store';

export class RefreshStoreError extends Error {
  constructor() {
    super('Refresh store operation failed.');
    this.name = 'RefreshStoreError';
  }
}

export interface RotatedRefreshSession {
  status: 'rotated';
  ownerId: string;
  issuer: 'local';
  subject: string;
  expiresAtMs: number;
}
export type RefreshRotationResult = RotatedRefreshSession | { status: 'replay' | 'invalid' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INITIALIZE_SQL = `
  UPDATE lingualoop_auth_sessions
  SET current_refresh_hash = $3
  WHERE owner_id = $1 AND id = $2 AND expires_at_ms > $4
    AND revoked_at_ms IS NULL AND current_refresh_hash IS NULL
  RETURNING id
`;
const ROTATE_SQL = `
  SELECT status, owner_id AS "ownerId", issuer, subject,
    expires_at_ms AS "expiresAtMs"
  FROM lingualoop_rotate_refresh($1, $2, $3, $4)
`;

function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new RefreshStoreError();
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new RefreshStoreError();
}
function millis(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RefreshStoreError();
}
function returnedExpiry(value: unknown, nowMs: number): number {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) throw new RefreshStoreError();
    value = Number(value);
  }
  millis(value);
  if (value <= nowMs) throw new RefreshStoreError();
  return value;
}
function rows(result: QueryResult, min: number, max: number): unknown[] {
  if (!result || !Array.isArray(result.rows) || result.rows.length < min || result.rows.length > max) {
    throw new RefreshStoreError();
  }
  return result.rows;
}

/** Persists only refresh hashes; token generation and plaintext handling belong to the caller. */
export class RefreshStore {
  constructor(private readonly executor: QueryExecutor) {
    if (!executor || typeof executor.query !== 'function') throw new TypeError('A query executor is required.');
  }

  async initialize(ownerUuid: string, sessionUuid: string, refreshHash: string, nowMs: number): Promise<boolean> {
    uuid(ownerUuid);
    uuid(sessionUuid);
    hash(refreshHash);
    millis(nowMs);
    try {
      const found = rows(await this.executor.query(INITIALIZE_SQL, [ownerUuid, sessionUuid, refreshHash, nowMs]), 0, 1);
      if (found.length === 0) return false;
      const row = found[0] as { id?: unknown } | null;
      if (!row || typeof row !== 'object') throw new RefreshStoreError();
      uuid(row.id);
      if (row.id.toLowerCase() !== sessionUuid.toLowerCase()) throw new RefreshStoreError();
      return true;
    } catch {
      throw new RefreshStoreError();
    }
  }

  async rotate(sessionUuid: string, presentedHash: string, nextHash: string, nowMs: number): Promise<RefreshRotationResult> {
    uuid(sessionUuid);
    hash(presentedHash);
    hash(nextHash);
    millis(nowMs);
    if (presentedHash === nextHash) throw new RefreshStoreError();
    try {
      const result = rows(await this.executor.query(ROTATE_SQL, [sessionUuid, presentedHash, nextHash, nowMs]), 1, 1)[0] as
        { status?: unknown; ownerId?: unknown; issuer?: unknown; subject?: unknown; expiresAtMs?: unknown } | null;
      if (!result || typeof result !== 'object') throw new RefreshStoreError();
      if (result.status === 'invalid' || result.status === 'replay') {
        if (result.ownerId != null || result.issuer != null || result.subject != null || result.expiresAtMs != null) {
          throw new RefreshStoreError();
        }
        return { status: result.status };
      }
      if (result.status !== 'rotated' || result.issuer !== 'local' || typeof result.subject !== 'string' ||
          result.subject.length === 0 || Buffer.from(result.subject, 'utf8').toString('utf8') !== result.subject ||
          result.subject.normalize('NFC') !== result.subject || Buffer.byteLength(result.subject, 'utf8') > 512 ||
          /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(result.subject)) throw new RefreshStoreError();
      uuid(result.ownerId);
      if (result.subject !== result.ownerId) throw new RefreshStoreError();
      const expiresAtMs = returnedExpiry(result.expiresAtMs, nowMs);
      return { status: 'rotated', ownerId: result.ownerId, issuer: 'local', subject: result.subject, expiresAtMs };
    } catch {
      throw new RefreshStoreError();
    }
  }
}
