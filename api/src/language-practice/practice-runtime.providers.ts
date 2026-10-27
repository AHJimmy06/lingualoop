import { Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { SttDiagnosticError } from './fastconformer-host';

export const PRACTICE_RUNTIME = Symbol('PRACTICE_RUNTIME');
export const PRACTICE_FFMPEG_PATH = Symbol('PRACTICE_FFMPEG_PATH');

export type PracticeRuntimeConfiguration = {
  serverUrl: string;
  model: 'base.en';
  ffmpegExecutable: string;
  pythonExecutable?: string;
  serverScript: string;
  port: number;
  startMode: 'managed' | 'external';
  cpuThreads: number;
};
type SttHost = { transcribe(path: string): Promise<string> };
const READINESS_TIMEOUT_MS = 6 * 60_000;
const MAX_REQUEST_MS = 900_000;

function isExactAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value) ||
      value.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..')) return false;
  const normalized = resolve(value);
  return process.platform === 'win32'
    ? normalized.toLowerCase() === value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    : normalized === value;
}

export function loadPracticeRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env): PracticeRuntimeConfiguration | undefined {
  try {
    if (env.LINGUALOOP_STT_ENABLED !== 'true') return undefined;
    const model = env.LINGUALOOP_STT_MODEL ?? 'base.en';
    const rawUrl = env.LINGUALOOP_STT_SERVER_URL;
    const ffmpegExecutable = env.LANGUAGE_PRACTICE_FFMPEG_PATH;
    const startMode = env.LINGUALOOP_STT_START_MODE ?? 'managed';
    const rawPython = env.LINGUALOOP_STT_PYTHON;
    const port = Number(env.LINGUALOOP_STT_PORT ?? '8080');
    const cpuThreads = Number(env.LINGUALOOP_STT_CPU_THREADS ?? '4');
    if (model !== 'base.en' || (startMode !== 'managed' && startMode !== 'external') ||
        typeof rawUrl !== 'string' || !isExactAbsolutePath(ffmpegExecutable) ||
        !Number.isInteger(port) || port < 1024 || port > 65535 ||
        !Number.isInteger(cpuThreads) || cpuThreads < 1 || cpuThreads > 16) return undefined;
    const parsed = new URL(rawUrl);
    // Audio may only go to our local process or a named, private Docker network service.
    const local = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port === String(port);
    const privateDocker = parsed.protocol === 'http:' && parsed.hostname === 'stt' && parsed.port === String(port);
    if (!(local || (privateDocker && startMode === 'external')) || parsed.username || parsed.password ||
        parsed.search || parsed.hash || parsed.pathname !== '/') return undefined;
    const pythonExecutable = rawPython === undefined ? undefined : rawPython;
    if (startMode === 'managed' && !isExactAbsolutePath(pythonExecutable)) return undefined;
    if (startMode === 'external' && !local && !privateDocker) return undefined;
    return {
      serverUrl: parsed.origin, model: 'base.en', ffmpegExecutable,
      pythonExecutable,
      serverScript: resolve(process.cwd(), 'scripts/whisper-stt-server.py'),
      port, startMode, cpuThreads,
    };
  } catch { return undefined; }
}

/** Owns local STT lifecycle; in Compose, waits on the private `stt` service instead. */
@Injectable()
export class PracticeRuntimeHost implements OnApplicationShutdown {
  private host?: SttHost;
  private stopped = false;
  private spawnFailed = false;
  private sttProcess?: ChildProcess;

  constructor(private readonly configuration: PracticeRuntimeConfiguration) {}

  async start(): Promise<void> {
    if (this.configuration.startMode === 'managed') {
      this.sttProcess = spawn(this.configuration.pythonExecutable!, [
        this.configuration.serverScript, '--host', '127.0.0.1', '--port', String(this.configuration.port),
        '--model', this.configuration.model, '--compute-type', 'int8',
        '--cpu-threads', String(this.configuration.cpuThreads),
      ], { windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' });
      this.sttProcess.once('error', () => { this.spawnFailed = true; this.sttProcess = undefined; });
    }
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error('Local STT startup cancelled');
      if (this.configuration.startMode === 'managed' &&
          (this.spawnFailed || this.sttProcess?.exitCode !== null && this.sttProcess?.exitCode !== undefined)) {
        throw new Error('Whisper STT exited during startup');
      }
      try {
        const response = await fetch(`${this.configuration.serverUrl}/ready`, { signal: AbortSignal.timeout(1_000) });
        const body: unknown = await response.json();
        if (response.ok && body && typeof body === 'object' &&
            (body as Record<string, unknown>).ready === true &&
            (body as Record<string, unknown>).model === 'base.en') return;
      } catch { /* model is still loading */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    throw new Error('Whisper STT did not become ready during API startup');
  }

  getHost(): SttHost {
    if (this.stopped) throw new SttDiagnosticError('host_stopped');
    return this.host ??= {
      transcribe: async (path: string) => {
        if (!isExactAbsolutePath(path)) throw new SttDiagnosticError('nemo_request_path');
        const file = await readFile(path);
        const form = new FormData();
        form.set('model', 'base.en');
        form.set('language', 'en');
        form.set('response_format', 'json');
        form.set('file', new Blob([file], { type: 'audio/wav' }), 'audio.wav');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MAX_REQUEST_MS);
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
          if (transcript.length > 30_000) throw new SttDiagnosticError('nemo_response_oversized');
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
    const child = this.sttProcess;
    this.sttProcess = undefined;
    if (!child || child.exitCode !== null) return;
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); return; } catch { /* try the direct child */ }
    }
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
}

export function createPracticeRuntimeProviders(configuration: PracticeRuntimeConfiguration): Provider[] {
  return [
    { provide: PRACTICE_RUNTIME, useFactory: () => new PracticeRuntimeHost(configuration) },
    { provide: PRACTICE_FFMPEG_PATH, useValue: configuration.ffmpegExecutable },
  ];
}
