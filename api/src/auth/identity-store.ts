import { normalizeEmail, isAccountRole, type AccountRole } from './account-role';
import { validateAccountName } from './account-store';

export interface QueryResult { rows: unknown[] }
/** Implementations bind all values and own transaction lifetime. */
export interface QueryExecutor {
  query(sql: string, parameters: readonly unknown[]): Promise<QueryResult>;
  withTransaction?<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}
export interface VerifiedIdentity { issuer: string; subject: string; email?: string }
export class IdentityStoreError extends Error {
  constructor() { super('Identity store operation failed.'); this.name = 'IdentityStoreError'; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class IdentityStore {
  constructor(private readonly executor: QueryExecutor) {
    if (!executor || typeof executor.query !== 'function') throw new TypeError('A query executor is required.');
  }
  /** Retired admission boundary: external identities can never create prototype accounts. */
  async getOrCreateOwner(_identity: VerifiedIdentity): Promise<string> { throw new IdentityStoreError(); }

  async findAccountByOwner(ownerId: string): Promise<{ name: string; email: string; role: AccountRole } | null> {
    try {
      if (!UUID.test(ownerId)) throw new IdentityStoreError();
      const result = await this.executor.query('SELECT name, email, role FROM lingualoop_accounts WHERE id = $1', [ownerId]);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new IdentityStoreError();
      const row = result.rows[0] as { name: unknown; email: unknown; role: unknown };
      if (!row || normalizeEmail(row.email) !== row.email || !isAccountRole(row.role)) throw new IdentityStoreError();
      validateAccountName(row.name);
      return { name: row.name, email: row.email as string, role: row.role };
    } catch { throw new IdentityStoreError(); }
  }
  async findOwnerByIdentity(identity: VerifiedIdentity): Promise<string | null> {
    try {
      if (!identity || identity.issuer !== 'local' || !UUID.test(identity.subject)) throw new IdentityStoreError();
      const result = await this.executor.query(`SELECT id FROM lingualoop_accounts
        WHERE issuer = $1 AND subject = $2 AND id::text = $2`, [identity.issuer, identity.subject]);
      if (!result.rows.length) return null;
      const row = result.rows[0] as { id?: unknown };
      if (result.rows.length !== 1 || !row || typeof row.id !== 'string' || !UUID.test(row.id) || row.id !== identity.subject) throw new IdentityStoreError();
      return row.id;
    } catch { throw new IdentityStoreError(); }
  }
}
