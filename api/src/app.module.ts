import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PracticeCatalogueController } from './language-practice/practice-catalogue.controller';
import { AdminAccountsController, CurrentAccountController } from './auth/accounts.controller';
import { PasswordAuthController } from './auth/password-auth.controller';
import { AUTH_STORE_PROVIDERS } from './auth/auth-store.providers';
import { PASSWORD_AUTH_PROVIDERS } from './auth/password-auth.providers';
import { createPracticeRuntimeProviders, loadPracticeRuntimeConfiguration } from './language-practice/practice-runtime.providers';
import { PracticeAudioController } from './language-practice/practice-audio.controller';
import { PracticeSynthesisController } from './language-practice/practice-synthesis.controller';
import { LanguagePracticeSessionController } from './language-practice/language-practice-session.controller';
import { LanguagePracticeTurnController } from './language-practice/language-practice-turn.controller';
import { createLanguagePracticeTurnProviders, LANGUAGE_PRACTICE_TURN_COACH, LANGUAGE_PRACTICE_TURN_SERVICE } from './language-practice/language-practice-turn.providers';
import { LANGUAGE_PRACTICE_SESSION_PROVIDERS } from './language-practice/language-practice-session.providers';
import { createPiperRuntimeProviders, loadPiperRuntimeConfiguration } from './language-practice/piper-runtime.providers';
import { PRACTICE_AUDIO_PREPARER, PracticeAudioService, practiceAudioPreparer } from './language-practice/practice-audio.service';
import { createLinguaLoopQueryExecutor, LINGUALOOP_QUERY_EXECUTOR, LinguaLoopPostgresProvider } from './db/postgres';

const practiceRuntimeConfiguration = loadPracticeRuntimeConfiguration();
const piperRuntimeConfiguration = loadPiperRuntimeConfiguration();
// Media/coach availability remains independent of account, refresh and catalogue routes.
const languagePracticeTurnProviders = practiceRuntimeConfiguration && piperRuntimeConfiguration
  ? createLanguagePracticeTurnProviders(process.env) : [];
const hasTurnProvider = (token: symbol) => languagePracticeTurnProviders.some(provider =>
  typeof provider === 'object' && 'provide' in provider && provider.provide === token);
const turnsEnabled = hasTurnProvider(LANGUAGE_PRACTICE_TURN_COACH) && hasTurnProvider(LANGUAGE_PRACTICE_TURN_SERVICE);

@Module({
  controllers: [
    HealthController, PasswordAuthController, CurrentAccountController, AdminAccountsController,
    PracticeCatalogueController, LanguagePracticeSessionController,
    LanguagePracticeTurnController,
    ...(practiceRuntimeConfiguration ? [PracticeAudioController] : []),
    ...(piperRuntimeConfiguration ? [PracticeSynthesisController] : []),
  ],
  providers: [
    { provide: LINGUALOOP_QUERY_EXECUTOR, useFactory: () => new LinguaLoopPostgresProvider(createLinguaLoopQueryExecutor()) },
    ...AUTH_STORE_PROVIDERS, ...LANGUAGE_PRACTICE_SESSION_PROVIDERS, ...PASSWORD_AUTH_PROVIDERS,
    ...(practiceRuntimeConfiguration ? [
      ...createPracticeRuntimeProviders(practiceRuntimeConfiguration),
      { provide: PRACTICE_AUDIO_PREPARER, useValue: practiceAudioPreparer }, PracticeAudioService,
    ] : []),
    ...(piperRuntimeConfiguration ? createPiperRuntimeProviders(piperRuntimeConfiguration) : []),
    ...(turnsEnabled ? languagePracticeTurnProviders : []),
  ],
})
export class AppModule {}
