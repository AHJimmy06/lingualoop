import { getLanguagePracticeReportAiDiagnostic, LanguagePracticeReportAiUnavailableError } from './language-practice-report-ai';
import type { LanguagePracticeReportAiAdapter, LanguagePracticeReportAiDiagnostic } from './language-practice-report-ai';
import {
  LanguagePracticeReportAdmissionError,
  LanguagePracticeReportStore,
  type BeginAiReportResult,
  type LanguagePracticeReport,
} from './language-practice-report-store';

export type LanguagePracticeReportStorePort = Pick<LanguagePracticeReportStore,
  'beginAiReport' | 'releaseAiReport' | 'finalizeAiReport'>;
export type LanguagePracticeReportAiPort = Pick<LanguagePracticeReportAiAdapter, 'generate'>;

type ServiceCode = 'admission_store' | 'busy' | 'adapter_unavailable' | 'generation_unknown' |
  'finalize_store' | 'claim_lost' | 'release_store';
type ServiceDetail = { code: ServiceCode; component: 'report_service' };
export type LanguagePracticeReportDiagnosticEvent = (ServiceDetail | LanguagePracticeReportAiDiagnostic) & {
  event: 'language_practice_report_failure' | 'language_practice_report_release_failure';
  stage: 'admission' | 'configuration' | 'generation' | 'finalize' | 'release';
};
export interface LanguagePracticeReportDiagnostics {
  report(event: LanguagePracticeReportDiagnosticEvent): void;
}

/** Coordinates durable report claims with a single optional, non-transactional AI request. */
export class LanguagePracticeReportService {
  constructor(
    private readonly store: LanguagePracticeReportStorePort,
    private readonly adapter?: LanguagePracticeReportAiPort,
    private readonly diagnostics: LanguagePracticeReportDiagnostics = {
      report: ({ event, ...detail }) => console.error(event, detail),
    },
  ) {}

  async getOrCreate(ownerId: string, sessionId: string): Promise<LanguagePracticeReport> {
    let admission: BeginAiReportResult;
    try {
      admission = await this.store.beginAiReport(ownerId, sessionId);
    } catch (error) {
      if (error instanceof LanguagePracticeReportAdmissionError) throw error;
      this.reportFailure('admission', 'admission_store');
      throw new LanguagePracticeReportAiUnavailableError();
    }
    if (admission.kind === 'existing' || admission.kind === 'no_evidence') return admission.report;
    if (admission.kind === 'busy') {
      this.reportFailure('admission', 'busy');
      throw new LanguagePracticeReportAiUnavailableError();
    }

    if (!this.adapter) {
      this.reportFailure('configuration', 'adapter_unavailable');
      await this.releaseBestEffort(ownerId, sessionId, admission.token);
      throw new LanguagePracticeReportAiUnavailableError();
    }
    let stage: 'generation' | 'finalize' = 'generation';
    let finalizeCode: 'finalize_store' | 'claim_lost' = 'finalize_store';
    try {
      const content = await this.adapter.generate(admission.turns, {
        topic: admission.topic,
        ...(admission.activity === undefined ? {} : { activity: admission.activity }),
        level: admission.level,
        difficulty: admission.difficulty,
        ...(admission.parameters?.length ? { parameters: admission.parameters } : {}),
      });
      stage = 'finalize';
      const report = await this.store.finalizeAiReport(ownerId, sessionId, admission.token, content);
      if (!report) {
        finalizeCode = 'claim_lost';
        throw new LanguagePracticeReportAiUnavailableError();
      }
      return report;
    } catch (error) {
      const detail = stage === 'generation' ? getLanguagePracticeReportAiDiagnostic(error) : undefined;
      this.emit({ event: 'language_practice_report_failure', stage,
        ...(detail ?? { code: stage === 'generation' ? 'generation_unknown' : finalizeCode, component: 'report_service' }) });
      await this.releaseBestEffort(ownerId, sessionId, admission.token);
      throw new LanguagePracticeReportAiUnavailableError();
    }
  }

  private reportFailure(stage: LanguagePracticeReportDiagnosticEvent['stage'], code: ServiceCode): void {
    this.emit({ event: 'language_practice_report_failure', stage, code, component: 'report_service' });
  }

  private emit(event: LanguagePracticeReportDiagnosticEvent): void {
    try { this.diagnostics.report(event); } catch { /* Diagnostics must never change the outcome. */ }
  }

  private async releaseBestEffort(ownerId: string, sessionId: string, token: string): Promise<void> {
    try { await this.store.releaseAiReport(ownerId, sessionId, token); } catch {
      this.emit({ event: 'language_practice_report_release_failure', stage: 'release', code: 'release_store', component: 'report_service' });
    }
  }
}
