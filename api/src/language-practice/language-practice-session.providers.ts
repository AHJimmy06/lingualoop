import type { Provider } from '@nestjs/common';
import { LINGUALOOP_QUERY_EXECUTOR } from '../db/postgres';
import { LanguagePracticeReportStore } from './language-practice-report-store';
import { createLanguagePracticeReportAiAdapter } from './language-practice-report.providers';
import { LanguagePracticeReportService } from './language-practice-report.service';
import { LanguagePracticeSessionStore } from './language-practice-session-store';
import { LanguagePracticeTurnStore } from './language-practice-turn-store';

export const LANGUAGE_PRACTICE_SESSION_STORE = Symbol('LANGUAGE_PRACTICE_SESSION_STORE');
export const LANGUAGE_PRACTICE_TURN_STORE = Symbol('LANGUAGE_PRACTICE_TURN_STORE');
export const LANGUAGE_PRACTICE_REPORT_STORE = Symbol('LANGUAGE_PRACTICE_REPORT_STORE');
export const LANGUAGE_PRACTICE_REPORT_SERVICE = Symbol('LANGUAGE_PRACTICE_REPORT_SERVICE');

export const LANGUAGE_PRACTICE_SESSION_PROVIDERS: Provider[] = [
  {
    provide: LANGUAGE_PRACTICE_SESSION_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof LanguagePracticeSessionStore>[0]) =>
      new LanguagePracticeSessionStore(executor),
  },
  {
    provide: LANGUAGE_PRACTICE_TURN_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof LanguagePracticeTurnStore>[0]) =>
      new LanguagePracticeTurnStore(executor),
  },
  {
    provide: LANGUAGE_PRACTICE_REPORT_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof LanguagePracticeReportStore>[0]) =>
      new LanguagePracticeReportStore(executor),
  },
  {
    provide: LANGUAGE_PRACTICE_REPORT_SERVICE,
    inject: [LANGUAGE_PRACTICE_REPORT_STORE],
    useFactory: (store: LanguagePracticeReportStore) =>
      new LanguagePracticeReportService(store, createLanguagePracticeReportAiAdapter(process.env)),
  },
];
