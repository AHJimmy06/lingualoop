import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { verifyPiperArtifact } from './piper-artifacts'
import type { PiperVoice } from './piper-artifacts'

const MAX_STARTUP_MS = 30_000
const MAX_STDERR_BYTES = 4_000
const TERM_GRACE_MS = 1_500
const KILL_GRACE_MS = 250
const READY_MARKER = 'Initialized piper'

type PiperHostConfig = {
  voice: PiperVoice
  executable: string
  modelPath: string
  modelSha256: string
  sidecarSha256: string
  startupTimeoutMs: number
}
type SpawnChild = (executable: string, args: string[], options: SpawnOptions) => ChildProcess
export type PiperProcessTreeSignal = (child: ChildProcess, signal: NodeJS.Signals) => void

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return } catch { /* fall through to child */ }
  }
  try { child.kill(signal) } catch { /* already exited */ }
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

  constructor(
    private readonly config: PiperHostConfig,
    private readonly spawnChild: SpawnChild = spawn,
    private readonly signalTree: PiperProcessTreeSignal = signalProcessTree,
  ) {
    if ((config.voice !== 'en' && config.voice !== 'es') || !config.executable ||
        !config.modelPath || !/^[a-f0-9]{64}$/.test(config.modelSha256) ||
        !/^[a-f0-9]{64}$/.test(config.sidecarSha256) ||
        !Number.isInteger(config.startupTimeoutMs) || config.startupTimeoutMs < 1 ||
        config.startupTimeoutMs > MAX_STARTUP_MS) {
      throw new Error('Invalid Piper host configuration')
    }
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
      if (this.child === child && chunk.length > 0) this.fail('Piper emitted unsolicited startup output')
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
    })
  }

  private processError(child: ChildProcess): void {
    if (this.child !== child) return
    if (this.startup) this.fail('Piper failed during startup')
    else if (this.ready) {
      this.ready = false
      void this.shutdown()
    }
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
    const startup = this.startup
    if (startup) {
      this.startup = undefined
      clearTimeout(startup.timer)
      startup.reject(new Error('Piper startup cancelled'))
    }
    this.ready = false
    const child = this.child
    if (!child || this.closed) return
    const closed = new Promise<void>((resolve) => child.once('close', () => { this.closed = true; resolve() }))
    try { this.signalTree(child, 'SIGTERM') } catch { /* continue bounded cleanup */ }
    if (await this.waitForClose(closed, TERM_GRACE_MS)) return
    try { this.signalTree(child, 'SIGKILL') } catch { /* continue bounded cleanup */ }
    await this.waitForClose(closed, KILL_GRACE_MS)
  }

  private async waitForClose(closed: Promise<void>, delay: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), delay) })
    const result = await Promise.race([closed.then(() => true), expired])
    if (timer) clearTimeout(timer)
    return result
  }
}
