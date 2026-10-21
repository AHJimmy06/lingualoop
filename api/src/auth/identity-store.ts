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
  /** Link a verified external identity only to an account provisioned by an administrator. */
  async linkExternalIdentity(identity: VerifiedIdentity): Promise<string> {
    try {
      if (!identity || (identity.issuer !== 'google' && identity.issuer !== 'microsoft') ||
          typeof identity.subject !== 'string' || !identity.subject.trim() ||
          Buffer.byteLength(identity.subject, 'utf8') > 512 ||
          normalizeEmail(identity.email) !== identity.email || !this.executor.withTransaction) {
        throw new IdentityStoreError();
      }
      return await this.executor.withTransaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lingualoop:external:${identity.issuer}:${identity.subject}`]);
        const existing = await tx.query(
          'SELECT account_id FROM lingualoop_external_identities WHERE issuer = $1 AND subject = $2 FOR UPDATE',
          [identity.issuer, identity.subject]);
        if (existing.rows.length === 1) {
          const ownerId = (existing.rows[0] as { account_id?: unknown }).account_id;
          if (typeof ownerId !== 'string') throw new IdentityStoreError();
          return ownerId;
        }
        if (existing.rows.length > 1) throw new IdentityStoreError();
        const account = await tx.query('SELECT id FROM lingualoop_accounts WHERE email = $1 FOR UPDATE', [identity.email]);
        if (account.rows.length !== 1) throw new IdentityStoreError();
        const ownerId = (account.rows[0] as { id?: unknown }).id;
        if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new IdentityStoreError();
        const linked = await tx.query(
          `INSERT INTO lingualoop_external_identities (account_id, issuer, subject, email)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING account_id`,
          [ownerId, identity.issuer, identity.subject, identity.email]);
        if (linked.rows.length === 1 && (linked.rows[0] as { account_id?: unknown }).account_id === ownerId) return ownerId;
        const raced = await tx.query(
          'SELECT account_id FROM lingualoop_external_identities WHERE issuer = $1 AND subject = $2',
          [identity.issuer, identity.subject]);
        if (raced.rows.length === 1 && (raced.rows[0] as { account_id?: unknown }).account_id === ownerId) return ownerId;
        throw new IdentityStoreError();
      });
    } catch { throw new IdentityStoreError(); }
  }

  /** External accounts cannot be auto-created; this historical entry point stays fail-closed. */
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
      if (!identity || !['local', 'google', 'microsoft'].includes(identity.issuer) ||
          typeof identity.subject !== 'string' || !identity.subject || identity.subject.trim() !== identity.subject ||
          Buffer.byteLength(identity.subject, 'utf8') > 512 || Buffer.from(identity.subject, 'utf8').toString('utf8') !== identity.subject ||
          identity.subject.normalize('NFC') !== identity.subject || /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(identity.subject) ||
          (identity.issuer === 'local' && !UUID.test(identity.subject))) throw new IdentityStoreError();
      const result = identity.issuer === 'local'
        ? await this.executor.query(`SELECT id FROM lingualoop_accounts
            WHERE issuer = 'local' AND subject = $1 AND id::text = $1`, [identity.subject])
        : (identity.issuer === 'google' || identity.issuer === 'microsoft')
          ? await this.executor.query('SELECT account_id AS id FROM lingualoop_external_identities WHERE issuer = $1 AND subject = $2', [identity.issuer, identity.subject])
          : (() => { throw new IdentityStoreError(); })();
      if (!result.rows.length) return null;
      const row = result.rows[0] as { id?: unknown };
      if (result.rows.length !== 1 || !row || typeof row.id !== 'string' || !UUID.test(row.id) ||
          (identity.issuer === 'local' && row.id !== identity.subject)) throw new IdentityStoreError();
      return row.id;
    } catch { throw new IdentityStoreError(); }
  }
}
