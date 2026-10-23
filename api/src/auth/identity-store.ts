import { normalizeEmail, isAccountRole, type AccountRole } from './account-role';
import { validateAccountName } from './account-store';

export interface QueryResult { rows: unknown[] }
/** Implementations bind all values and own transaction lifetime. */
export interface QueryExecutor {
  query(sql: string, parameters: readonly unknown[]): Promise<QueryResult>;
  withTransaction?<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}
export interface VerifiedIdentity { issuer: string; subject: string; email?: string; name?: string }
export class IdentityStoreError extends Error {
  constructor() { super('Identity store operation failed.'); this.name = 'IdentityStoreError'; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class IdentityStore {
  constructor(private readonly executor: QueryExecutor) {
    if (!executor || typeof executor.query !== 'function') throw new TypeError('A query executor is required.');
  }
  /** Register or retrieve a cryptographically verified external identity. Never merge by email alone. */
  async linkExternalIdentity(identity: VerifiedIdentity): Promise<string> {
    try {
      if (!identity || !['google', 'microsoft'].includes(identity.issuer) ||
          typeof identity.subject !== 'string' || !identity.subject ||
          identity.subject.trim() !== identity.subject || /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(identity.subject) ||
          identity.subject.normalize('NFC') !== identity.subject ||
          Buffer.byteLength(identity.subject, 'utf8') > 512 ||
          normalizeEmail(identity.email) !== identity.email || !this.executor.withTransaction) throw new IdentityStoreError();
      const name = identity.name ?? identity.email!;
      validateAccountName(name);
      return await this.executor.withTransaction(async tx => {
        // Serialize registration by email as well as provider identity.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['lingualoop:oauth-registration']);
        const existing = await tx.query(
          'SELECT account_id FROM lingualoop_external_identities WHERE issuer = $1 AND subject = $2 FOR UPDATE',
          [identity.issuer, identity.subject]);
        if (existing.rows.length === 1) {
          const ownerId = (existing.rows[0] as { account_id?: unknown }).account_id;
          if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new IdentityStoreError();
          await tx.query('UPDATE lingualoop_accounts SET name = $2, updated_at = now() WHERE id = $1', [ownerId, name]);
          return ownerId;
        }
        if (existing.rows.length) throw new IdentityStoreError();
        const matches = await tx.query('SELECT id FROM lingualoop_accounts WHERE email = $1 FOR UPDATE', [identity.email]);
        let ownerId: string;
        if (matches.rows.length === 1) {
          ownerId = (matches.rows[0] as { id: string }).id;
          // Manual role invitations may be claimed once; another identity needs explicit linking.
          const linked = await tx.query('SELECT account_id FROM lingualoop_external_identities WHERE account_id = $1', [ownerId]);
          if (linked.rows.length) throw new IdentityStoreError();
          await tx.query('UPDATE lingualoop_accounts SET name = $2, updated_at = now() WHERE id = $1', [ownerId, name]);
        } else if (!matches.rows.length) {
          // Only the explicitly named, Google-verified address may bootstrap administrator access.
          const role = identity.issuer === 'google' && identity.email === 'jimmy.anilema234@gmail.com' ? 'admin' : 'student';
          const created = await tx.query(
            `WITH new_id AS (SELECT gen_random_uuid() AS id)
             INSERT INTO lingualoop_accounts (id, issuer, subject, name, email, role)
             SELECT id, 'local', id::text, $1, $2, $3 FROM new_id RETURNING id`,
            [name, identity.email, role]);
          if (created.rows.length !== 1) throw new IdentityStoreError();
          ownerId = (created.rows[0] as { id: string }).id;
        } else throw new IdentityStoreError();
        if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new IdentityStoreError();
        // Prevent claiming the reserved administrator email through another provider.
        if (identity.email === 'jimmy.anilema234@gmail.com' && identity.issuer !== 'google') throw new IdentityStoreError();
        const linked = await tx.query(
          `INSERT INTO lingualoop_external_identities (account_id, issuer, subject, email)
           VALUES ($1, $2, $3, $4) RETURNING account_id`,
          [ownerId, identity.issuer, identity.subject, identity.email]);
        if (linked.rows.length !== 1) throw new IdentityStoreError();
        return ownerId;
      });
    } catch { throw new IdentityStoreError(); }
  }

  async getOrCreateOwner(identity: VerifiedIdentity): Promise<string> { return this.linkExternalIdentity(identity); }

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
