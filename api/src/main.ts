import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PRACTICE_RUNTIME, loadPracticeRuntimeConfiguration, type PracticeRuntimeHost } from './language-practice/practice-runtime.providers';
import { PIPER_RUNTIME, loadPiperRuntimeConfiguration, type PiperRuntimeHost } from './language-practice/piper-runtime.providers';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  if (loadPracticeRuntimeConfiguration()) {
    await app.get<PracticeRuntimeHost>(PRACTICE_RUNTIME).start();
  }
  if (loadPiperRuntimeConfiguration()) {
    await app.get<PiperRuntimeHost>(PIPER_RUNTIME).start();
  }
  const port = Number(process.env.PORT) || 3400;
  await app.listen(port);
}

void bootstrap().catch(() => {
  process.exitCode = 1;
});
