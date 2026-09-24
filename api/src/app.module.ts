import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
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
  ],
})
export class AppModule {}
