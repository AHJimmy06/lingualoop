import { randomUUID } from 'node:crypto';
import { normalizeEmail, isAccountRole, type AccountRole } from './account-role';
import type { QueryExecutor } from './identity-store';
import { hashPassword, validatePassword, verifyPassword } from './password-hash';

export const LINGUALOOP_ACCOUNT_STORE = Symbol('LINGUALOOP_ACCOUNT_STORE');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface AccountDto { id: string; name: string; email: string; role: AccountRole; createdAt: string }
export interface AccountInput { name: string; email: string; password: string; role: 'teacher' | 'student' }
export class AccountStoreError extends Error { constructor() { super('Account service unavailable.'); } }
export class DuplicateAccountError extends AccountStoreError {}

export function validateAccountName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 ||
      Buffer.from(value, 'utf8').toString('utf8') !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid account name.');
}
export function validateAccountInput(value: unknown): AccountInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid account.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'email,name,password,role' ||
      (input.role !== 'teacher' && input.role !== 'student')) throw new TypeError('Invalid account.');
  validateAccountName(input.name);
  validatePassword(input.password);
  return { name: input.name, email: normalizeEmail(input.email), password: input.password, role: input.role };
}
function account(value: unknown): AccountDto {
  if (!value || typeof value !== 'object') throw new AccountStoreError();
  const row = value as Record<string, unknown>;
  validateAccountName(row.name);
  if (typeof row.id !== 'string' || !UUID.test(row.id) || normalizeEmail(row.email) !== row.email || !isAccountRole(row.role)) throw new AccountStoreError();
  const date = row.created_at instanceof Date ? row.created_at : typeof row.created_at === 'string' ? new Date(row.created_at) : null;
  if (!date || !Number.isFinite(date.valueOf())) throw new AccountStoreError();
  return { id: row.id, name: row.name, email: row.email as string, role: row.role, createdAt: date.toISOString() };
}
const INSERT = `INSERT INTO lingualoop_accounts (id, issuer, subject, name, email, password_hash, role)
  VALUES ($5::uuid, 'local', $5::uuid::text, $1, $2, $3, $4)
  ON CONFLICT (email) DO NOTHING RETURNING id, name, email, role, created_at`;
// Same bounded KDF work for nonexistent accounts; not a credential and never persisted.
const DUMMY_HASH = `scrypt:16384:8:1:${'0'.repeat(32)}:${'0'.repeat(128)}`;

export class AccountStore {
  constructor(private readonly executor: QueryExecutor) {}
  async create(value: AccountInput): Promise<AccountDto> {
    try {
      const input = validateAccountInput(value);
      const hash = await hashPassword(input.password);
      const result = await this.executor.query(INSERT, [input.name, input.email, hash, input.role, randomUUID()]);
      if (!result.rows.length) throw new DuplicateAccountError();
      if (result.rows.length !== 1) throw new AccountStoreError();
      return account(result.rows[0]);
    } catch (error) {
      if (error instanceof DuplicateAccountError) throw error;
      throw new AccountStoreError();
    }
  }
  async list(): Promise<AccountDto[]> {
    try {
      const result = await this.executor.query('SELECT id, name, email, role, created_at FROM lingualoop_accounts ORDER BY created_at, id', []);
      return result.rows.map(account);
    } catch { throw new AccountStoreError(); }
  }
  async authenticate(email: string, password: string): Promise<string | null> {
    try {
      email = normalizeEmail(email);
      validatePassword(password);
      const result = await this.executor.query(`SELECT id, name, email, role, created_at, password_hash
        FROM lingualoop_accounts WHERE email = $1 AND issuer = 'local' AND subject = id::text`, [email]);
      if (result.rows.length > 1) throw new AccountStoreError();
      const row = result.rows[0] as Record<string, unknown> | undefined;
      const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
      if (!row || !valid) return null;
      return account(row).id;
    } catch { throw new AccountStoreError(); }
  }
  /** Offline, serialized, create-once bootstrap. Never changes an existing account or password. */
  async bootstrapFirstAdmin(name: string, email: string, password: string): Promise<AccountDto> {
    try {
      validateAccountName(name);
      email = normalizeEmail(email);
      validatePassword(password);
      const hash = await hashPassword(password);
      if (!this.executor.withTransaction) throw new AccountStoreError();
      return await this.executor.withTransaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['lingualoop:first-admin']);
        // The initial administrator must be the first account of any role.
        const accounts = await tx.query('SELECT id FROM lingualoop_accounts LIMIT 1', []);
        if (accounts.rows.length) throw new AccountStoreError();
        const result = await tx.query(INSERT, [name, email, hash, 'admin', randomUUID()]);
        if (result.rows.length !== 1) throw new AccountStoreError();
        return account(result.rows[0]);
      });
    } catch { throw new AccountStoreError(); }
  }
}
