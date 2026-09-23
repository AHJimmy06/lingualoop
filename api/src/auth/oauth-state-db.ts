import type { OAuthStateRecord, OAuthStateStore } from './oauth-state.service';
import type { QueryExecutor, QueryResult } from './identity-store';

export class OAuthStateStoreError extends Error {
  constructor() {
    super('OAuth state store operation failed.');
    this.name = 'OAuthStateStoreError';
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INSERT_STATE_SQL = `
  INSERT INTO lingualoop_oauth_states (state_hash, expires_at_ms, provider)
  VALUES ($1, $2, $3)
`;
const CONSUME_STATE_SQL = `
  DELETE FROM lingualoop_oauth_states
  WHERE state_hash = $1
  RETURNING expires_at_ms, provider
`;

function validateHash(hash: string): void {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) throw new OAuthStateStoreError();
}

function validateRecord(record: OAuthStateRecord): void {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0 ||
      record.provider !== 'google') {
    throw new OAuthStateStoreError();
  }
}

function returnedRecord(result: QueryResult): OAuthStateRecord | null {
  if (!result || !Array.isArray(result.rows)) throw new OAuthStateStoreError();
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw new OAuthStateStoreError();

  const row = result.rows[0] as { expires_at_ms?: unknown; provider?: unknown } | null;
  if (!row || typeof row !== 'object' || row.provider !== 'google') throw new OAuthStateStoreError();
  const rawExpiry = row.expires_at_ms;
  const expiresAt = typeof rawExpiry === 'number'
    ? rawExpiry
    : typeof rawExpiry === 'string' && /^\d+$/.test(rawExpiry)
      ? Number(rawExpiry)
      : Number.NaN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new OAuthStateStoreError();
  return { expiresAt, provider: 'google' };
}

/** PostgreSQL-backed, hash-only OAuth state storage. */
export class OAuthStateDbStore implements OAuthStateStore {
  constructor(private readonly executor: QueryExecutor) {
    if (!executor || typeof executor.query !== 'function') throw new TypeError('A query executor is required.');
  }

  async put(hash: string, record: OAuthStateRecord): Promise<void> {
    validateHash(hash);
    validateRecord(record);
    try {
      await this.executor.query(INSERT_STATE_SQL, [hash, record.expiresAt, record.provider]);
    } catch {
      throw new OAuthStateStoreError();
    }
  }

  async consume(hash: string): Promise<OAuthStateRecord | null> {
    validateHash(hash);
    try {
      return returnedRecord(await this.executor.query(CONSUME_STATE_SQL, [hash]));
    } catch {
      throw new OAuthStateStoreError();
    }
  }
}
