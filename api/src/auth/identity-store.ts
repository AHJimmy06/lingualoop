export interface QueryResult {
  rows: unknown[];
}

/** Minimal adapter boundary; implementations bind values rather than interpolate SQL. */
export interface QueryExecutor {
  query(sql: string, parameters: readonly unknown[]): Promise<QueryResult>;
}

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
}

export class IdentityStoreError extends Error {
  constructor() {
    super('Identity store operation failed.');
    this.name = 'IdentityStoreError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SUBJECT_BYTES = 512;

const UPSERT_OWNER_SQL = `
  INSERT INTO lingualoop_accounts (issuer, subject)
  VALUES ($1, $2)
  ON CONFLICT (issuer, subject) DO UPDATE
    SET issuer = EXCLUDED.issuer
  RETURNING id
`;
const FIND_OWNER_SQL = `
  SELECT id FROM lingualoop_accounts
  WHERE issuer = $1 AND subject = $2
`;

function validateIdentity(identity: VerifiedIdentity): void {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new IdentityStoreError();
  const { issuer, subject } = identity;
  if (issuer !== 'google') throw new IdentityStoreError();
  if (typeof subject !== 'string' || subject.length === 0 ||
      Buffer.byteLength(subject, 'utf8') > MAX_SUBJECT_BYTES ||
      Buffer.from(subject, 'utf8').toString('utf8') !== subject ||
      subject.normalize('NFC') !== subject || /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(subject)) {
    throw new IdentityStoreError();
  }
}

function returnedId(result: QueryResult, required: boolean): string | null {
  if (!result || !Array.isArray(result.rows)) throw new IdentityStoreError();
  if (result.rows.length === 0 && !required) return null;
  if (result.rows.length !== 1) throw new IdentityStoreError();
  const row = result.rows[0] as { id?: unknown } | null;
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !UUID_PATTERN.test(row.id)) {
    throw new IdentityStoreError();
  }
  return row.id;
}

export class IdentityStore {
  constructor(private readonly executor: QueryExecutor) {
    if (!executor || typeof executor.query !== 'function') throw new TypeError('A query executor is required.');
  }

  async getOrCreateOwner(identity: VerifiedIdentity): Promise<string> {
    validateIdentity(identity);
    try {
      return returnedId(await this.executor.query(UPSERT_OWNER_SQL, [identity.issuer, identity.subject]), true)!;
    } catch {
      throw new IdentityStoreError();
    }
  }

  async findOwnerByIdentity(identity: VerifiedIdentity): Promise<string | null> {
    validateIdentity(identity);
    try {
      return returnedId(await this.executor.query(FIND_OWNER_SQL, [identity.issuer, identity.subject]), false);
    } catch {
      throw new IdentityStoreError();
    }
  }
}
