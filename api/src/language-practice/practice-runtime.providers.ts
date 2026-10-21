import { Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { SttDiagnosticError } from './fastconformer-host';

export const PRACTICE_RUNTIME = Symbol('PRACTICE_RUNTIME');
export const PRACTICE_FFMPEG_PATH = Symbol('PRACTICE_FFMPEG_PATH');

export type PracticeRuntimeConfiguration = {
  serverUrl: string;
  model: string;
  ffmpegExecutable: string;
  sttExecutable: string;
  port: number;
};
type SttHost = { transcribe(path: string): Promise<string> };

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isExactAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value) ||
      value.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..')) return false;
  const normalized = resolve(value);
  return process.platform === 'win32'
    ? normalized.toLowerCase() === value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    : normalized === value;
}

export function loadPracticeRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): PracticeRuntimeConfiguration | undefined {
  try {
    if (env.LINGUALOOP_STT_ENABLED !== 'true') return undefined;
    const rawUrl = env.LINGUALOOP_STT_SERVER_URL;
    const model = env.LINGUALOOP_STT_MODEL;
    const ffmpegExecutable = env.LANGUAGE_PRACTICE_FFMPEG_PATH;
    const sttExecutable = env.LINGUALOOP_STT_EXECUTABLE;
    const port = Number(env.LINGUALOOP_STT_PORT);
    if (typeof rawUrl !== 'string' || typeof model !== 'string' || !MODEL_ID_PATTERN.test(model) ||
        !isExactAbsolutePath(ffmpegExecutable) || !isExactAbsolutePath(sttExecutable) ||
        !Number.isInteger(port) || port < 1024 || port > 65535) return undefined;
    const parsed = new URL(rawUrl);
    // Speech remains strictly local: a bad .env must never turn private recordings into remote uploads.
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port ||
        parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') return undefined;
    return {
      serverUrl: parsed.origin,
      model,
      ffmpegExecutable,
      sttExecutable,
      port,
    };
  } catch {
    return undefined;
  }
}

/** The external local model server is started explicitly by a developer command, never by API startup. */
@Injectable()
export class PracticeRuntimeHost implements OnApplicationShutdown {
  private host?: { transcribe(path: string): Promise<string> };
  private stopped = false;
  private sttProcess?: ChildProcess;

  constructor(private readonly configuration: PracticeRuntimeConfiguration) {}

  async start(): Promise<void> {
    const healthUrl = `${this.configuration.serverUrl}/ready`;
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return; // An explicitly started local STT instance is already serving.
    } catch { /* API owns startup when STT is not already running. */ }
    this.sttProcess = spawn(this.configuration.sttExecutable, [
      'serve', '--host', '127.0.0.1', '--port', String(this.configuration.port),
      '--asr-model', this.configuration.model, '--device', 'cuda', '--no-ui',
    ], { windowsHide: true, stdio: 'ignore' });
    this.sttProcess.once('error', () => { this.sttProcess = undefined; });
    for (let attempt = 0; attempt < 90; attempt += 1) {
      if (this.sttProcess.exitCode !== null) throw new Error('Local STT exited during API startup');
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
      } catch { /* Model server is still loading. */ }
    }
    throw new Error('Local STT did not become ready during API startup');
  }

  getHost(): SttHost {
    if (this.stopped) throw new SttDiagnosticError('host_stopped');
    return this.host ??= {
      transcribe: async (path: string) => {
        if (!isExactAbsolutePath(path)) throw new SttDiagnosticError('nemo_request_path');
        const file = await readFile(path);
        const form = new FormData();
        form.set('model', 'default');
        form.set('language', 'auto');
        form.set('response_format', 'json');
        form.set('file', new Blob([file], { type: 'audio/wav' }), 'audio.wav');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        try {
          const response = await fetch(`${this.configuration.serverUrl}/v1/audio/transcriptions`, {
            method: 'POST', body: form, signal: controller.signal,
          });
          if (!response.ok) throw new SttDiagnosticError('nemo_request_process');
          const payload: unknown = await response.json();
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
              typeof (payload as Record<string, unknown>).text !== 'string') {
            throw new SttDiagnosticError('nemo_response_invalid');
          }
          const transcript = (payload as { text: string }).text.trim();
          if (!transcript) throw new SttDiagnosticError('nemo_no_speech');
          if (transcript.length > 4_000) throw new SttDiagnosticError('nemo_response_oversized');
          return transcript;
        } catch (error) {
          if (error instanceof SttDiagnosticError) throw error;
          throw new SttDiagnosticError('nemo_request_process');
        } finally { clearTimeout(timer); }
      },
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.sttProcess?.kill();
    this.sttProcess = undefined;
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
