import type { AuthSession } from '../../auth-session';
import { isEmail, isName } from '../auth/profile';
import { hasExactKeys, isRecord, isTimestamp, isUuid, LanguagePracticeClientError, parseReport, responseError, type LanguagePracticeReport } from '../language-practice/language-practice-client';
export type PracticeSubmission = {
  sessionId: string; studentId: string; studentName: string; studentEmail: string;
  status: 'ACTIVE' | 'EXPIRED' | 'COMPLETED'; startedAt: string; completedAt: string | null; reportAvailable: boolean;
};
function parseSubmission(value: unknown): PracticeSubmission {
  if (!isRecord(value) || !hasExactKeys(value, ['sessionId', 'studentId', 'studentName', 'studentEmail', 'status', 'startedAt', 'completedAt', 'reportAvailable']) ||
      !isUuid(value.sessionId) || !isUuid(value.studentId) || !isName(value.studentName) || !isEmail(value.studentEmail) ||
      typeof value.status !== 'string' || !['ACTIVE', 'EXPIRED', 'COMPLETED'].includes(value.status) ||
      !isTimestamp(value.startedAt) || !(value.completedAt === null || isTimestamp(value.completedAt)) || typeof value.reportAvailable !== 'boolean') {
    throw new LanguagePracticeClientError('invalid-response');
  }
  return value as PracticeSubmission;
}
export class TeacherResultsClient {
  constructor(private readonly session: AuthSession) {}
  async listSubmissions(practiceId: string): Promise<PracticeSubmission[]> {
    this.validateId(practiceId);
    const value = await this.get(`/api/language-practice/practices/${practiceId}/submissions`);
    if (!isRecord(value) || !hasExactKeys(value, ['submissions']) || !Array.isArray(value.submissions)) throw new LanguagePracticeClientError('invalid-response');
    const submissions = value.submissions.map(parseSubmission);
    if (new Set(submissions.map(item => item.sessionId)).size !== submissions.length) throw new LanguagePracticeClientError('invalid-response');
    return submissions;
  }
  async getReport(practiceId: string, sessionId: string): Promise<LanguagePracticeReport> {
    this.validateId(practiceId); this.validateId(sessionId);
    // Read the persisted student DTO; never invoke the student report-generation POST.
    return parseReport(await this.get(`/api/language-practice/practices/${practiceId}/submissions/${sessionId}/report`), sessionId);
  }
  private validateId(id: string) { if (!isUuid(id)) throw new LanguagePracticeClientError('invalid-input'); }
  private async get(path: string): Promise<unknown> {
    const response = await this.session.getWithRefresh(path);
    if (!response) throw new LanguagePracticeClientError('unavailable');
    if (!response.ok) throw responseError(response.status);
    try { return await response.json(); } catch { throw new LanguagePracticeClientError('invalid-response'); }
  }
}
