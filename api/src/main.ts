import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT) || 3400;
  await app.listen(port);
}

void bootstrap().catch(() => {
  process.exitCode = 1;
});
