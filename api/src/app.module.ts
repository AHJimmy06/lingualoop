import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AUTH_STORE_PROVIDERS } from './auth/auth-store.providers';
import {
  createLinguaLoopQueryExecutor,
  LINGUALOOP_QUERY_EXECUTOR,
  LinguaLoopPostgresProvider,
} from './db/postgres';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: LINGUALOOP_QUERY_EXECUTOR,
      useFactory: () => new LinguaLoopPostgresProvider(createLinguaLoopQueryExecutor()),
    },
    ...AUTH_STORE_PROVIDERS,
  ],
})
export class AppModule {}
