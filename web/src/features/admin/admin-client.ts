import type { AuthSession } from '../../auth-session';
import { isEmail, isName, isPassword } from '../auth/profile';
import { hasExactKeys, isRecord, isUuid, isTimestamp, LanguagePracticeClientError, responseError } from '../language-practice/language-practice-client';
export type Approval = { id: string; name: string; email: string; role: 'admin' | 'teacher' | 'student'; createdAt: string };
export type AccountInput = { name: string; email: string; password: string; role: 'teacher' | 'student' };
export function validateAccountInput(value: unknown): asserts value is AccountInput {
  if (!isRecord(value) || !hasExactKeys(value, ['name', 'email', 'password', 'role']) || !isName(value.name) || !isEmail(value.email) || !isPassword(value.password) ||
      typeof value.role !== 'string' || !['teacher', 'student'].includes(value.role)) throw new LanguagePracticeClientError('invalid-input');
}
function parseApproval(value: unknown): Approval {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'name', 'email', 'role', 'createdAt']) ||
      !isUuid(value.id) || !isName(value.name) || !isEmail(value.email) || typeof value.role !== 'string' || !['admin', 'teacher', 'student'].includes(value.role) ||
      !isTimestamp(value.createdAt)) throw new LanguagePracticeClientError('invalid-response');
  return value as Approval;
}
export class AdminAccountsClient {
  constructor(private readonly session: AuthSession) {}
  async listAccounts(): Promise<Approval[]> {
    const value = await this.read(await this.session.getWithRefresh('/api/admin/accounts'));
    if (!isRecord(value) || !hasExactKeys(value, ['accounts']) || !Array.isArray(value.accounts)) throw new LanguagePracticeClientError('invalid-response');
    const accounts = value.accounts.map(parseApproval);
    if (new Set(accounts.map(item => item.id)).size !== accounts.length || new Set(accounts.map(item => item.email)).size !== accounts.length) throw new LanguagePracticeClientError('invalid-response');
    return accounts;
  }
  async createAccount(input: AccountInput): Promise<Approval> {
    validateAccountInput(input);
    const response = await this.session.postAdminAccounts('/api/admin/accounts', input);
    if (response?.status === 409) {
      const error = new LanguagePracticeClientError('conflict', 409);
      error.message = 'An account with this email already exists. Check the accounts list before trying again.';
      throw error;
    }
    const account = parseApproval(await this.read(response));
    if (account.role === 'admin') throw new LanguagePracticeClientError('invalid-response');
    return account;
  }
  private async read(response: Response | null): Promise<unknown> {
    if (!response) throw new LanguagePracticeClientError('unavailable');
    if (!response.ok) throw responseError(response.status);
    try { return await response.json(); } catch { throw new LanguagePracticeClientError('invalid-response'); }
  }
}
