import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { GoogleAuthController, GOOGLE_AUTH_RATE_LIMITER, GoogleAuthRateLimiter } from './auth/google-auth.controller';
import { AUTH_STORE_PROVIDERS } from './auth/auth-store.providers';
import { GOOGLE_AUTH_PROVIDERS, isGoogleAuthConfigurationValid } from './auth/google-auth.providers';
import {
  createLinguaLoopQueryExecutor,
  LINGUALOOP_QUERY_EXECUTOR,
  LinguaLoopPostgresProvider,
} from './db/postgres';

const googleAuthConfigured = isGoogleAuthConfigurationValid();

@Module({
  controllers: [HealthController, ...(googleAuthConfigured ? [GoogleAuthController] : [])],
  providers: [
    {
      provide: LINGUALOOP_QUERY_EXECUTOR,
      useFactory: () => new LinguaLoopPostgresProvider(createLinguaLoopQueryExecutor()),
    },
    ...AUTH_STORE_PROVIDERS,
    ...(googleAuthConfigured ? GOOGLE_AUTH_PROVIDERS : []),
    ...(googleAuthConfigured ? [{ provide: GOOGLE_AUTH_RATE_LIMITER, useClass: GoogleAuthRateLimiter }] : []),
  ],
})
export class AppModule {}
