import { LanguagePracticeReportAiUnavailableError } from './language-practice-report-ai';
import type { LanguagePracticeReportAiAdapter } from './language-practice-report-ai';
import {
  LanguagePracticeReportAdmissionError,
  LanguagePracticeReportStore,
  type BeginAiReportResult,
  type LanguagePracticeReport,
} from './language-practice-report-store';

export type LanguagePracticeReportStorePort = Pick<LanguagePracticeReportStore,
  'beginAiReport' | 'releaseAiReport' | 'finalizeAiReport'>;
export type LanguagePracticeReportAiPort = Pick<LanguagePracticeReportAiAdapter, 'generate'>;

/** Coordinates durable report claims with a single optional, non-transactional AI request. */
export class LanguagePracticeReportService {
  constructor(
    private readonly store: LanguagePracticeReportStorePort,
    private readonly adapter?: LanguagePracticeReportAiPort,
  ) {}

  async getOrCreate(ownerId: string, sessionId: string): Promise<LanguagePracticeReport> {
    let admission: BeginAiReportResult;
    try {
      admission = await this.store.beginAiReport(ownerId, sessionId);
    } catch (error) {
      if (error instanceof LanguagePracticeReportAdmissionError) throw error;
      throw new LanguagePracticeReportAiUnavailableError();
    }
    if (admission.kind === 'existing' || admission.kind === 'no_evidence') return admission.report;
    if (admission.kind === 'busy') throw new LanguagePracticeReportAiUnavailableError();

    if (!this.adapter) {
      await this.releaseBestEffort(ownerId, sessionId, admission.token);
      throw new LanguagePracticeReportAiUnavailableError();
    }
    try {
      const content = await this.adapter.generate(admission.turns, {
        topic: admission.topic,
        level: admission.level,
      });
      const report = await this.store.finalizeAiReport(ownerId, sessionId, admission.token, content);
      if (!report) throw new Error();
      return report;
    } catch {
      await this.releaseBestEffort(ownerId, sessionId, admission.token);
      throw new LanguagePracticeReportAiUnavailableError();
    }
  }

  private async releaseBestEffort(ownerId: string, sessionId: string, token: string): Promise<void> {
    try { await this.store.releaseAiReport(ownerId, sessionId, token); } catch { /* preserve sanitized failure */ }
  }
}
