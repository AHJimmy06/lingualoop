import { Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { join, resolve } from 'node:path';
import { FastConformerHost, SttDiagnosticError } from './fastconformer-host';

export const PRACTICE_RUNTIME = Symbol('PRACTICE_RUNTIME');
export const PRACTICE_FFMPEG_PATH = Symbol('PRACTICE_FFMPEG_PATH');

export type PracticeRuntimeConfiguration = {
  pythonExecutable: string;
  modelPath: string;
  expectedSha256: string;
  ffmpegExecutable: string;
  workerPath: string;
};

const requiredPathSettings = [
  ['LINGUALOOP_STT_PYTHON', 'pythonExecutable'],
  ['LINGUALOOP_FASTCONFORMER_MODEL_PATH', 'modelPath'],
  ['LANGUAGE_PRACTICE_FFMPEG_PATH', 'ffmpegExecutable'],
] as const;

function isExactAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !value.startsWith('/')) return false;
  if (value === '/') return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return false;
  return resolve(value) === value;
}

export function loadPracticeRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): PracticeRuntimeConfiguration | undefined {
  try {
    const paths: Partial<Pick<PracticeRuntimeConfiguration, 'pythonExecutable' | 'modelPath' | 'ffmpegExecutable'>> = {};
    for (const [setting, key] of requiredPathSettings) {
      const value = env[setting];
      if (!isExactAbsolutePath(value)) return undefined;
      paths[key] = value;
    }
    const expectedSha256 = env.LINGUALOOP_FASTCONFORMER_MODEL_SHA256;
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) return undefined;
    return {
      pythonExecutable: paths.pythonExecutable!,
      modelPath: paths.modelPath!,
      ffmpegExecutable: paths.ffmpegExecutable!,
      expectedSha256,
      workerPath: join(__dirname, '../../scripts/fastconformer-worker.py'),
    };
  } catch {
    return undefined;
  }
}

/** Nest owns this singleton; the expensive host is created only when a consumer asks for it. */
@Injectable()
export class PracticeRuntimeHost implements OnApplicationShutdown {
  private host?: FastConformerHost;
  private stopped = false;

  constructor(private readonly configuration: PracticeRuntimeConfiguration) {}

  getHost(): FastConformerHost {
    if (this.stopped) throw new SttDiagnosticError('host_stopped');
    return this.host ??= new FastConformerHost({
      pythonExecutable: this.configuration.pythonExecutable,
      workerPath: this.configuration.workerPath,
      modelPath: this.configuration.modelPath,
      expectedSha256: this.configuration.expectedSha256,
      startupTimeoutMs: 60_000,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.host) await this.host.shutdown();
  }
}

export function createPracticeRuntimeProviders(
  configuration: PracticeRuntimeConfiguration,
): Provider[] {
  return [
    {
      provide: PRACTICE_RUNTIME,
      useFactory: () => new PracticeRuntimeHost(configuration),
    },
    { provide: PRACTICE_FFMPEG_PATH, useValue: configuration.ffmpegExecutable },
  ];
}
