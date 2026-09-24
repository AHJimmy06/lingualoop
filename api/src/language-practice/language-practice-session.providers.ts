import type { Provider } from '@nestjs/common';
import { LINGUALOOP_QUERY_EXECUTOR } from '../db/postgres';
import { LanguagePracticeSessionStore } from './language-practice-session-store';
import { LanguagePracticeTurnStore } from './language-practice-turn-store';

export const LANGUAGE_PRACTICE_SESSION_STORE = Symbol('LANGUAGE_PRACTICE_SESSION_STORE');
export const LANGUAGE_PRACTICE_TURN_STORE = Symbol('LANGUAGE_PRACTICE_TURN_STORE');

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
];
