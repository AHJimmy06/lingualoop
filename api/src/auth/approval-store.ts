import { normalizeEmail, isAccountRole, type AccountRole } from './account-role';
import type { QueryExecutor, QueryResult } from './identity-store';

export interface AccountApproval {
  id: string;
  email: string;
  role: AccountRole;
  linked: boolean;
  createdAt: string;
}

export class ApprovalStoreError extends Error {
  constructor() { super('Account approval operation failed.'); }
}
export class DuplicateApprovalError extends Error {
  constructor() { super('Account approval already exists.'); }
}

const COLUMNS = 'id, email, role, (account_id IS NOT NULL) AS linked, created_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function approvals(result: QueryResult): AccountApproval[] {
  if (!Array.isArray(result?.rows)) throw new ApprovalStoreError();
  return result.rows.map(value => {
    const row = value as Record<string, unknown>;
    if (!row || typeof row.id !== 'string' || !UUID.test(row.id) || normalizeEmail(row.email) !== row.email ||
        !isAccountRole(row.role) || typeof row.linked !== 'boolean') throw new ApprovalStoreError();
    const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new ApprovalStoreError();
    return { id: row.id, email: row.email as string, role: row.role, linked: row.linked, createdAt };
  });
}

export class ApprovalStore {
  constructor(private readonly executor: QueryExecutor) {}

  async create(email: string, role: 'teacher' | 'student'): Promise<AccountApproval> {
    let rows;
    try {
      if (normalizeEmail(email) !== email || (role !== 'teacher' && role !== 'student')) throw new ApprovalStoreError();
      rows = approvals(await this.executor.query(
        `INSERT INTO lingualoop_account_approvals (email, role) VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING RETURNING ${COLUMNS}`, [email, role]));
    } catch { throw new ApprovalStoreError(); }
    if (rows.length === 0) throw new DuplicateApprovalError();
    if (rows.length !== 1) throw new ApprovalStoreError();
    return rows[0];
  }

  async list(): Promise<AccountApproval[]> {
    try {
      return approvals(await this.executor.query(
        `SELECT ${COLUMNS} FROM lingualoop_account_approvals ORDER BY created_at, id`, []));
    } catch { throw new ApprovalStoreError(); }
  }

  /** Offline only. No controller/provider invokes this during startup or public login. */
  async bootstrapFirstAdmin(email: string): Promise<AccountApproval> {
    try {
      if (normalizeEmail(email) !== email || !this.executor.withTransaction) throw new ApprovalStoreError();
      const result = await this.executor.withTransaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['lingualoop:first-admin']);
        const admins = approvals(await tx.query(
          `SELECT ${COLUMNS} FROM lingualoop_account_approvals WHERE role = 'admin' FOR UPDATE`, []));
        if (admins.length) return admins.length === 1 && admins[0].email === email ? admins[0] : null;
        // Existing teacher/student approval is never promoted; concurrent email conflicts fail closed.
        const rows = approvals(await tx.query(
          `INSERT INTO lingualoop_account_approvals (email, role) VALUES ($1, 'admin')
           ON CONFLICT (email) DO NOTHING RETURNING ${COLUMNS}`, [email]));
        return rows.length === 1 ? rows[0] : null;
      });
      if (!result) throw new ApprovalStoreError();
      return result;
    } catch { throw new ApprovalStoreError(); }
  }
}
