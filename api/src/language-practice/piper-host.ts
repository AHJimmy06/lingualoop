import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyPiperArtifact } from './piper-artifacts'
import type { PiperVoice } from './piper-artifacts'
import { parsePiperResponse, serializePiperRequest, MAX_PIPER_RESPONSE_BYTES } from './piper-protocol'
import { readValidatedPiperWav } from './piper-wav'

const MAX_STARTUP_MS = 30_000
const MAX_STDERR_BYTES = 4_000
const TERM_GRACE_MS = 1_500
const KILL_GRACE_MS = 250
const READY_MARKER = 'Initialized piper'
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000
const MAX_REQUEST_TIMEOUT_MS = 90_000
const GENERATED_DIR_PREFIX = 'lingualoop-piper-'

type PiperHostConfig = {
  voice: PiperVoice
  executable: string
  modelPath: string
  modelSha256: string
  sidecarSha256: string
  startupTimeoutMs: number
  requestTimeoutMs?: number
}
type SpawnChild = (executable: string, args: string[], options: SpawnOptions) => ChildProcess
export type PiperProcessTreeSignal = (child: ChildProcess, signal: NodeJS.Signals) => void
type RemoveDirectory = typeof rm

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return } catch { /* fall through to child */ }
  }
  try { child.kill(signal) } catch { /* already exited */ }
}

type SynthesisRequest = {
  resolve: (buffer: Buffer) => void
  reject: (error: Error) => void
  outputPath?: string
  directory?: string
  stdout: Buffer
  timer: NodeJS.Timeout
  reading: boolean
  cleanup?: Promise<void>
  directoryReady?: Promise<void>
  failureMessage?: string
  settled?: boolean
}

export class PiperHost {
  private child?: ChildProcess
  private startPromise?: Promise<void>
  private shutdownPromise?: Promise<void>
  private startup?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  private stderrBytes = 0
  private stderr = ''
  private ready = false
  private closed = false
  private request?: SynthesisRequest
  private cancelledRequest?: SynthesisRequest

  constructor(
    private readonly config: PiperHostConfig,
    private readonly spawnChild: SpawnChild = spawn,
    private readonly signalTree: PiperProcessTreeSignal = signalProcessTree,
    private readonly removeDirectory: RemoveDirectory = rm,
  ) {
    if ((config.voice !== 'en' && config.voice !== 'es') || !config.executable ||
        !config.modelPath || !/^[a-f0-9]{64}$/.test(config.modelSha256) ||
        !/^[a-f0-9]{64}$/.test(config.sidecarSha256) ||
        !Number.isInteger(config.startupTimeoutMs) || config.startupTimeoutMs < 1 ||
        config.startupTimeoutMs > MAX_STARTUP_MS ||
        (config.requestTimeoutMs !== undefined && (!Number.isInteger(config.requestTimeoutMs) ||
          config.requestTimeoutMs < 1 || config.requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS))) {
      throw new Error('Invalid Piper host configuration')
    }
  }

  synthesize(text: string): Promise<Buffer> {
    if (this.request || this.shutdownPromise || this.closed) return Promise.reject(new Error('Piper request unavailable'))
    let request!: SynthesisRequest
    const result = new Promise<Buffer>((resolve, reject) => {
      request = {
        resolve, reject, stdout: Buffer.alloc(0), reading: false,
        timer: setTimeout(() => this.failRequest(request, 'Piper request timed out'),
          this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      }
      this.request = request
    })
    void this.performSynthesis(request, text)
    return result
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.shutdownPromise || this.closed) return Promise.reject(new Error('Piper host is stopped'))
    this.startPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Piper startup timed out'), this.config.startupTimeoutMs)
      this.startup = { resolve, reject, timer }
      void this.launch().catch(() => this.fail('Could not start Piper'))
    })
    return this.startPromise
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.stopChild()
    return this.shutdownPromise
  }

  private async launch(): Promise<void> {
    try {
      await verifyPiperArtifact(
        this.config.voice, this.config.modelPath, this.config.modelSha256, this.config.sidecarSha256,
      )
    } catch {
      this.fail('Could not verify Piper artifacts')
      return
    }
    if (!this.startup || this.shutdownPromise) return

    let child: ChildProcess
    try {
      child = this.spawnChild(this.config.executable, ['--model', this.config.modelPath, '--json-input'], {
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      this.fail('Could not start Piper')
      return
    }
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child !== child || chunk.length === 0) return
      if (!this.ready) { this.fail('Piper emitted unsolicited startup output'); return }
      this.receiveResponse(chunk)
    })
    child.stdout?.on('error', () => this.processError(child))
    child.stderr?.on('error', () => this.processError(child))
    child.stdin?.on('error', () => this.processError(child))
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.child !== child || !this.startup) return
      this.stderrBytes += Buffer.byteLength(chunk)
      if (this.stderrBytes > MAX_STDERR_BYTES) {
        this.fail('Piper startup output exceeded limit')
        return
      }
      this.stderr += chunk.toString()
      const markers = this.stderr.split(READY_MARKER).length - 1
      if (markers > 1) {
        this.fail('Piper returned malformed startup output')
      } else if (markers === 1) {
        this.finishStartup()
      }
    })
    child.once('error', () => this.processError(child))
    child.once('close', () => {
      if (this.child !== child) return
      this.closed = true
      this.ready = false
      if (this.startup) this.fail('Piper closed during startup')
      else if (this.request) this.failRequest(this.request, 'Piper closed during synthesis')
    })
  }

  private processError(child: ChildProcess): void {
    if (this.child !== child) return
    if (this.startup) this.fail('Piper failed during startup')
    else if (this.ready || this.request) {
      if (this.request) this.failRequest(this.request, 'Piper process failed')
      this.ready = false
      void this.shutdown()
    }
  }

  private async performSynthesis(request: SynthesisRequest, text: string): Promise<void> {
    try {
      await this.start()
      this.assertCurrentRequest(request)
      request.directoryReady = mkdtemp(join(tmpdir(), GENERATED_DIR_PREFIX)).then((directory) => {
        request.directory = directory
      })
      await request.directoryReady
      this.assertCurrentRequest(request)
      const outputPath = join(request.directory!, 'output.wav')
      request.outputPath = outputPath
      const line = serializePiperRequest(text, outputPath)
      const child = this.child
      if (!child?.stdin || !this.ready) throw new Error('Piper unavailable')
      await new Promise<void>((resolve, reject) => {
        try {
          child.stdin!.write(line, (error?: Error | null) => error ? reject(error) : resolve())
        } catch { reject(new Error('Piper write failed')) }
      })
      this.assertCurrentRequest(request)
    } catch {
      if (this.request === request) this.failRequest(request, 'Piper synthesis failed')
    }
  }

  private receiveResponse(chunk: Buffer): void {
    const request = this.request
    if (!request || request.reading || !request.outputPath) {
      if (request) this.failRequest(request, 'Piper returned unexpected output')
      else { this.ready = false; void this.shutdown() }
      return
    }
    if (request.stdout.length + chunk.length > MAX_PIPER_RESPONSE_BYTES + 1) {
      this.failRequest(request, 'Piper response exceeded limit')
      return
    }
    request.stdout = Buffer.concat([request.stdout, chunk])
    const newline = request.stdout.indexOf(10)
    if (newline === -1) return
    if (newline !== request.stdout.length - 1) {
      this.failRequest(request, 'Piper returned extra output')
      return
    }
    try {
      parsePiperResponse(request.stdout.subarray(0, newline).toString('utf8'), request.outputPath)
    } catch {
      this.failRequest(request, 'Piper returned invalid response')
      return
    }
    request.reading = true
    void this.finishSynthesis(request)
  }

  private async finishSynthesis(request: SynthesisRequest): Promise<void> {
    let audio: Buffer | undefined
    try {
      this.assertCurrentRequest(request)
      audio = await readValidatedPiperWav(request.outputPath!)
      this.assertCurrentRequest(request)
      await this.cleanupRequest(request)
      this.assertCurrentRequest(request)
    } catch {
      if (this.request === request) this.failRequest(request, 'Piper synthesis failed')
    }
    if (audio && this.request === request) {
      clearTimeout(request.timer)
      this.request = undefined
      this.settleRequest(request, () => request.resolve(audio!))
    }
  }

  private cleanupRequest(request: SynthesisRequest): Promise<void> {
    if (!request.directory) return Promise.resolve()
    request.cleanup ??= this.removeDirectory(request.directory, { recursive: true, force: true })
    return request.cleanup
  }

  private assertCurrentRequest(request: SynthesisRequest): void {
    if (this.request !== request || this.shutdownPromise || this.closed) throw new Error('Piper request cancelled')
  }

  private failRequest(request: SynthesisRequest, message: string): void {
    if (this.request !== request) return
    this.request = undefined
    this.cancelledRequest = request
    request.failureMessage = message
    clearTimeout(request.timer)
    this.ready = false
    void this.shutdown().catch(async () => {
      await request.directoryReady?.catch(() => {})
      try { await this.cleanupRequest(request) } catch { /* settlement remains generic */ }
      this.settleRequest(request, () => request.reject(new Error('Piper synthesis failed')))
    })
  }

  private settleRequest(request: SynthesisRequest, settle: () => void): void {
    if (request.settled) return
    request.settled = true
    settle()
  }

  private finishStartup(): void {
    const startup = this.startup
    if (!startup) return
    this.startup = undefined
    clearTimeout(startup.timer)
    this.ready = true
    startup.resolve()
  }

  private fail(message: string): void {
    const startup = this.startup
    if (!startup) return
    this.startup = undefined
    clearTimeout(startup.timer)
    startup.reject(new Error(message))
    void this.shutdown()
  }

  private async stopChild(): Promise<void> {
    const request = this.request ?? this.cancelledRequest
    this.request = undefined
    this.cancelledRequest = undefined
    if (request) clearTimeout(request.timer)
    const startup = this.startup
    if (startup) {
      this.startup = undefined
      clearTimeout(startup.timer)
      startup.reject(new Error('Piper startup cancelled'))
    }
    this.ready = false
    const child = this.child
    if (child && !this.closed) {
      const closed = new Promise<void>((resolve) => child.once('close', () => { this.closed = true; resolve() }))
      try { this.signalTree(child, 'SIGTERM') } catch { /* continue bounded cleanup */ }
      if (!await this.waitForClose(closed, TERM_GRACE_MS)) {
        try { this.signalTree(child, 'SIGKILL') } catch { /* continue bounded cleanup */ }
        await this.waitForClose(closed, KILL_GRACE_MS)
      }
    }
    if (request) {
      await request.directoryReady?.catch(() => {})
      let cleanupFailed = false
      try { await this.cleanupRequest(request) } catch { cleanupFailed = true }
      const message = cleanupFailed ? 'Piper synthesis failed' : (request.failureMessage ?? 'Piper request cancelled')
      this.settleRequest(request, () => request.reject(new Error(message)))
    }
  }

  private async waitForClose(closed: Promise<void>, delay: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), delay) })
    const result = await Promise.race([closed.then(() => true), expired])
    if (timer) clearTimeout(timer)
    return result
  }
}
