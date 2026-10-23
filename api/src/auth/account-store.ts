import { randomUUID } from 'node:crypto';
import { normalizeEmail, isAccountRole, type AccountRole } from './account-role';
import type { QueryExecutor } from './identity-store';

export const LINGUALOOP_ACCOUNT_STORE = Symbol('LINGUALOOP_ACCOUNT_STORE');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface AccountDto { id: string; name: string | null; email: string; role: AccountRole; createdAt: string }
export interface AccountInput { email: string; role: 'teacher' | 'student' }
export class AccountStoreError extends Error { constructor() { super('Account service unavailable.'); } }
export class DuplicateAccountError extends AccountStoreError {}

export function validateAccountName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 ||
      Buffer.from(value, 'utf8').toString('utf8') !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid account name.');
}
export function validateAccountInput(value: unknown): AccountInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid account.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'email,role' ||
      (input.role !== 'teacher' && input.role !== 'student')) throw new TypeError('Invalid account.');
  return { email: normalizeEmail(input.email), role: input.role };
}
function account(value: unknown): AccountDto {
  if (!value || typeof value !== 'object') throw new AccountStoreError();
  const row = value as Record<string, unknown>;
  if (row.name !== null) validateAccountName(row.name);
  if (typeof row.id !== 'string' || !UUID.test(row.id) || normalizeEmail(row.email) !== row.email || !isAccountRole(row.role)) throw new AccountStoreError();
  const date = row.created_at instanceof Date ? row.created_at : typeof row.created_at === 'string' ? new Date(row.created_at) : null;
  if (!date || !Number.isFinite(date.valueOf())) throw new AccountStoreError();
  return { id: row.id, name: row.name as string | null, email: row.email as string, role: row.role, createdAt: date.toISOString() };
}
const INSERT = `INSERT INTO lingualoop_accounts (id, issuer, subject, name, email, role)
  VALUES ($3::uuid, 'local', $3::uuid::text, NULL, $1, $2)
  ON CONFLICT (email) DO NOTHING RETURNING id, name, email, role, created_at`;
export class AccountStore {
  constructor(private readonly executor: QueryExecutor) {}
  async create(value: AccountInput): Promise<AccountDto> {
    try {
      const input = validateAccountInput(value);
      const result = await this.executor.query(INSERT, [input.email, input.role, randomUUID()]);
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
  /** Password authentication and offline password bootstrapping are retired. */
  async authenticate(_email: string, _password: string): Promise<string | null> { return null; }
  async bootstrapFirstAdmin(_name: string, _email: string, _password: string): Promise<AccountDto> {
    throw new AccountStoreError();
  }
}
