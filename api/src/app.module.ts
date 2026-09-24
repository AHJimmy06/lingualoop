import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { GoogleAuthController, GOOGLE_AUTH_RATE_LIMITER, GoogleAuthRateLimiter } from './auth/google-auth.controller';
import { AUTH_STORE_PROVIDERS } from './auth/auth-store.providers';
import { GOOGLE_AUTH_PROVIDERS, isGoogleAuthConfigurationValid } from './auth/google-auth.providers';
import { createPracticeRuntimeProviders, loadPracticeRuntimeConfiguration } from './language-practice/practice-runtime.providers';
import { PracticeAudioController } from './language-practice/practice-audio.controller';
import { PRACTICE_AUDIO_PREPARER, PracticeAudioService, practiceAudioPreparer } from './language-practice/practice-audio.service';
import {
  createLinguaLoopQueryExecutor,
  LINGUALOOP_QUERY_EXECUTOR,
  LinguaLoopPostgresProvider,
} from './db/postgres';

const googleAuthConfigured = isGoogleAuthConfigurationValid();
const practiceRuntimeConfiguration = googleAuthConfigured ? loadPracticeRuntimeConfiguration() : undefined;

@Module({
  controllers: [
    HealthController,
    ...(googleAuthConfigured ? [GoogleAuthController] : []),
    ...(googleAuthConfigured && practiceRuntimeConfiguration ? [PracticeAudioController] : []),
  ],
  providers: [
    {
      provide: LINGUALOOP_QUERY_EXECUTOR,
      useFactory: () => new LinguaLoopPostgresProvider(createLinguaLoopQueryExecutor()),
    },
    ...AUTH_STORE_PROVIDERS,
    ...(googleAuthConfigured ? GOOGLE_AUTH_PROVIDERS : []),
    ...(practiceRuntimeConfiguration ? [
      ...createPracticeRuntimeProviders(practiceRuntimeConfiguration),
      { provide: PRACTICE_AUDIO_PREPARER, useValue: practiceAudioPreparer },
      PracticeAudioService,
    ] : []),
    ...(googleAuthConfigured ? [{ provide: GOOGLE_AUTH_RATE_LIMITER, useClass: GoogleAuthRateLimiter }] : []),
  ],
})
export class AppModule {}
