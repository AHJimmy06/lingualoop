import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { GoogleAuthController, GOOGLE_AUTH_RATE_LIMITER, GoogleAuthRateLimiter } from './auth/google-auth.controller';
import { AUTH_STORE_PROVIDERS } from './auth/auth-store.providers';
import { GOOGLE_AUTH_PROVIDERS, isGoogleAuthConfigurationValid } from './auth/google-auth.providers';
import { createPracticeRuntimeProviders, loadPracticeRuntimeConfiguration } from './language-practice/practice-runtime.providers';
import { PracticeAudioController } from './language-practice/practice-audio.controller';
import { PracticeSynthesisController } from './language-practice/practice-synthesis.controller';
import { LanguagePracticeSessionController } from './language-practice/language-practice-session.controller';
import { LanguagePracticeTurnController } from './language-practice/language-practice-turn.controller';
import { createLanguagePracticeTurnProviders, LANGUAGE_PRACTICE_TURN_COACH, LANGUAGE_PRACTICE_TURN_SERVICE } from './language-practice/language-practice-turn.providers';
import { LANGUAGE_PRACTICE_SESSION_PROVIDERS } from './language-practice/language-practice-session.providers';
import { createPiperRuntimeProviders, loadPiperRuntimeConfiguration } from './language-practice/piper-runtime.providers';
import { PRACTICE_AUDIO_PREPARER, PracticeAudioService, practiceAudioPreparer } from './language-practice/practice-audio.service';
import {
  createLinguaLoopQueryExecutor,
  LINGUALOOP_QUERY_EXECUTOR,
  LinguaLoopPostgresProvider,
} from './db/postgres';

const googleAuthConfigured = isGoogleAuthConfigurationValid();
const practiceRuntimeConfiguration = googleAuthConfigured ? loadPracticeRuntimeConfiguration() : undefined;
const piperRuntimeConfiguration = googleAuthConfigured ? loadPiperRuntimeConfiguration() : undefined;
// Adapter construction validates the guarded key file without making a provider request. Invalid
// coach configuration exposes no turn route and is intentionally isolated from other API routes.
const languagePracticeTurnProviders = googleAuthConfigured && practiceRuntimeConfiguration && piperRuntimeConfiguration
  ? createLanguagePracticeTurnProviders(process.env) : [];
const hasLanguagePracticeTurnProvider = (token: symbol) => languagePracticeTurnProviders.some((provider) =>
  typeof provider === 'object' && 'provide' in provider && provider.provide === token);
const languagePracticeTurnEnabled = Boolean(googleAuthConfigured && practiceRuntimeConfiguration && piperRuntimeConfiguration &&
  hasLanguagePracticeTurnProvider(LANGUAGE_PRACTICE_TURN_COACH) &&
  hasLanguagePracticeTurnProvider(LANGUAGE_PRACTICE_TURN_SERVICE));

@Module({
  controllers: [
    HealthController,
    ...(googleAuthConfigured ? [GoogleAuthController, LanguagePracticeSessionController] : []),
    ...(languagePracticeTurnEnabled ? [LanguagePracticeTurnController] : []),
    ...(googleAuthConfigured && practiceRuntimeConfiguration ? [PracticeAudioController] : []),
    ...(googleAuthConfigured && piperRuntimeConfiguration ? [PracticeSynthesisController] : []),
  ],
  providers: [
    {
      provide: LINGUALOOP_QUERY_EXECUTOR,
      useFactory: () => new LinguaLoopPostgresProvider(createLinguaLoopQueryExecutor()),
    },
    ...AUTH_STORE_PROVIDERS,
    ...(googleAuthConfigured ? LANGUAGE_PRACTICE_SESSION_PROVIDERS : []),
    ...(googleAuthConfigured ? GOOGLE_AUTH_PROVIDERS : []),
    ...(practiceRuntimeConfiguration ? [
      ...createPracticeRuntimeProviders(practiceRuntimeConfiguration),
      { provide: PRACTICE_AUDIO_PREPARER, useValue: practiceAudioPreparer },
      PracticeAudioService,
    ] : []),
    ...(googleAuthConfigured && piperRuntimeConfiguration
      ? createPiperRuntimeProviders(piperRuntimeConfiguration) : []),
    ...(languagePracticeTurnEnabled ? languagePracticeTurnProviders : []),
    ...(googleAuthConfigured ? [{ provide: GOOGLE_AUTH_RATE_LIMITER, useClass: GoogleAuthRateLimiter }] : []),
  ],
})
export class AppModule {}
