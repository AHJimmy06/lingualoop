import type { QueryExecutor, QueryResult } from './identity-store';

export class SessionStoreError extends Error {
  constructor() {
    super('Session store operation failed.');
    this.name = 'SessionStoreError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_SESSION_SQL = `
  INSERT INTO lingualoop_auth_sessions (owner_id, expires_at_ms)
  VALUES ($1, $2)
  RETURNING id
`;
const FIND_ACTIVE_SESSION_SQL = `
  SELECT id FROM lingualoop_auth_sessions
  WHERE owner_id = $1 AND id = $2 AND expires_at_ms > $3 AND revoked_at_ms IS NULL
`;
const REVOKE_SESSION_SQL = `
  UPDATE lingualoop_auth_sessions
  SET revoked_at_ms = $3
  WHERE owner_id = $1 AND id = $2 AND revoked_at_ms IS NULL
`;

function validateUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new SessionStoreError();
}

function validateMillis(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new SessionStoreError();
}

function returnedSessionId(result: QueryResult): string {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) throw new SessionStoreError();
  const row = result.rows[0] as { id?: unknown } | null;
  if (!row || typeof row !== 'object') throw new SessionStoreError();
  validateUuid(row.id);
  return row.id;
}

/** Stores opaque auth-session records; issuance policy remains with the caller. */
export class SessionStore {
  constructor(private readonly executor: QueryExecutor) {
    if (!executor || typeof executor.query !== 'function') throw new TypeError('A query executor is required.');
  }

  async createSession(ownerUuid: string, expiresAtMs: number): Promise<string> {
    validateUuid(ownerUuid);
    validateMillis(expiresAtMs);
    try {
      return returnedSessionId(await this.executor.query(CREATE_SESSION_SQL, [ownerUuid, expiresAtMs]));
    } catch {
      throw new SessionStoreError();
    }
  }

  async isSessionActive(ownerUuid: string, sessionUuid: string, nowMs: number): Promise<boolean> {
    validateUuid(ownerUuid);
    validateUuid(sessionUuid);
    validateMillis(nowMs);
    try {
      const result = await this.executor.query(FIND_ACTIVE_SESSION_SQL, [ownerUuid, sessionUuid, nowMs]);
      if (!result || !Array.isArray(result.rows) || result.rows.length > 1) throw new SessionStoreError();
      if (result.rows.length === 0) return false;
      const row = result.rows[0] as { id?: unknown } | null;
      if (!row || typeof row !== 'object') throw new SessionStoreError();
      validateUuid(row.id);
      if (row.id.toLowerCase() !== sessionUuid.toLowerCase()) throw new SessionStoreError();
      return true;
    } catch {
      throw new SessionStoreError();
    }
  }

  async revokeSession(ownerUuid: string, sessionUuid: string, nowMs: number): Promise<void> {
    validateUuid(ownerUuid);
    validateUuid(sessionUuid);
    validateMillis(nowMs);
    try {
      await this.executor.query(REVOKE_SESSION_SQL, [ownerUuid, sessionUuid, nowMs]);
    } catch {
      throw new SessionStoreError();
    }
  }
}
