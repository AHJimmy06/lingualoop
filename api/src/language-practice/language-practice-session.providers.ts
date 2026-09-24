import type { Provider } from '@nestjs/common';
import { LINGUALOOP_QUERY_EXECUTOR } from '../db/postgres';
import { LanguagePracticeSessionStore } from './language-practice-session-store';

export const LANGUAGE_PRACTICE_SESSION_STORE = Symbol('LANGUAGE_PRACTICE_SESSION_STORE');

export const LANGUAGE_PRACTICE_SESSION_PROVIDERS: Provider[] = [
  {
    provide: LANGUAGE_PRACTICE_SESSION_STORE,
    inject: [LINGUALOOP_QUERY_EXECUTOR],
    useFactory: (executor: ConstructorParameters<typeof LanguagePracticeSessionStore>[0]) =>
      new LanguagePracticeSessionStore(executor),
  },
];
