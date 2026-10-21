import { Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { isAbsolute, resolve } from 'node:path';
import { PiperHost } from './piper-host';

export const PIPER_RUNTIME = Symbol('PIPER_RUNTIME');

export type PiperVoiceConfiguration = {
  executable: string;
  modelPath: string;
  modelSha256: string;
  sidecarSha256: string;
};
export type PiperRuntimeConfiguration = Record<'en' | 'es', PiperVoiceConfiguration>;
export type PiperHostLike = { synthesize(text: string): Promise<Buffer> };

function isExactAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 2 || value.includes('\0') || !isAbsolute(value) ||
      value.split(/[\\/]+/).some((part) => part === '.' || part === '..')) return false;
  return process.platform === 'win32'
    ? resolve(value).toLowerCase() === value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    : resolve(value) === value;
}

export function loadPiperRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): PiperRuntimeConfiguration | undefined {
  try {
    const executable = env.LANGUAGE_PRACTICE_PIPER_PATH;
    const voices = {} as PiperRuntimeConfiguration;
    if (!isExactAbsolutePath(executable)) return undefined;
    for (const voice of ['en', 'es'] as const) {
      const modelPath = env[`LANGUAGE_PRACTICE_PIPER_MODEL_${voice.toUpperCase()}`];
      const modelSha256 = env[`LINGUALOOP_PIPER_MODEL_${voice.toUpperCase()}_SHA256`];
      const sidecarSha256 = env[`LINGUALOOP_PIPER_SIDECAR_${voice.toUpperCase()}_SHA256`];
      if (!isExactAbsolutePath(modelPath) || !modelPath.endsWith('.onnx') ||
          typeof modelSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(modelSha256) ||
          typeof sidecarSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sidecarSha256)) return undefined;
      voices[voice] = { executable, modelPath, modelSha256, sidecarSha256 };
    }
    return voices;
  } catch {
    return undefined;
  }
}

/** Nest owns hosts, but each process and its model are started only on first synthesis. */
@Injectable()
export class PiperRuntimeHost implements OnApplicationShutdown {
  private readonly hosts: Partial<Record<'en' | 'es', PiperHost>> = {};

  constructor(private readonly configuration: PiperRuntimeConfiguration) {}

  async start(): Promise<void> {
    await Promise.all((['en', 'es'] as const).map((voice) => this.getHost(voice).start()));
  }

  getHost(voice: 'en' | 'es'): PiperHost {
    return this.hosts[voice] ??= new PiperHost({
      voice,
      ...this.configuration[voice],
      startupTimeoutMs: 30_000,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(Object.values(this.hosts).map((host) => (host as PiperHost).shutdown()));
  }
}

export function createPiperRuntimeProviders(configuration: PiperRuntimeConfiguration): Provider[] {
  return [{ provide: PIPER_RUNTIME, useFactory: () => new PiperRuntimeHost(configuration) }];
}
