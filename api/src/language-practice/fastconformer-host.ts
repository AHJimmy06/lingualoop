import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { FASTCONFORMER_MODEL_ID, FastConformerProtocolError, parseReady } from './fastconformer-protocol'

export { FASTCONFORMER_MODEL_ID } from './fastconformer-protocol'
const MAX_STARTUP_MS = 30_000
const MAX_STDOUT_BYTES = 8_192
const MAX_STDERR_BYTES = 4_000
const TERM_GRACE_MS = 1_500
const KILL_GRACE_MS = 250

type HostConfig = {
  pythonExecutable: string
  workerPath: string
  modelPath: string
  expectedSha256: string
  startupTimeoutMs: number
}
type SpawnChild = (executable: string, args: string[], options: SpawnOptions) => ChildProcess
export type ProcessTreeSignal = (child: ChildProcess, signal: NodeJS.Signals) => void

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return } catch { /* fall through to child */ }
  }
  try { child.kill(signal) } catch { /* already exited */ }
}

export class FastConformerHost {
  private child?: ChildProcess
  private startup?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  private startPromise?: Promise<void>
  private shutdownPromise?: Promise<void>
  private stdout = ''
  private stderr = ''
  private closed = false
  private ready = false

  constructor(
    private readonly config: HostConfig,
    private readonly spawnChild: SpawnChild = spawn,
    private readonly signalTree: ProcessTreeSignal = signalProcessTree,
  ) {
    if (!config.pythonExecutable || !config.workerPath || !config.modelPath ||
        !/^[a-f0-9]{64}$/.test(config.expectedSha256) ||
        !Number.isInteger(config.startupTimeoutMs) || config.startupTimeoutMs < 1 ||
        config.startupTimeoutMs > MAX_STARTUP_MS) {
      throw new Error('Invalid FastConformer host configuration')
    }
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.shutdownPromise) return Promise.reject(new Error('FastConformer host is stopped'))
    this.startPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail('FastConformer startup timed out'), this.config.startupTimeoutMs)
      this.startup = { resolve, reject, timer }
      try {
        const child = this.spawnChild(this.config.pythonExecutable, [
          this.config.workerPath, '--model-path', this.config.modelPath,
          '--model-sha256', this.config.expectedSha256,
        ], { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        this.child = child
        child.stdout?.on('data', (chunk: Buffer) => this.readStdout(chunk))
        child.stderr?.on('data', (chunk: Buffer) => {
          this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR_BYTES)
        })
        child.once('error', () => this.fail('Could not start FastConformer worker'))
        child.once('close', () => {
          this.closed = true
          if (this.startup) this.fail('FastConformer worker closed during startup')
        })
      } catch {
        this.fail('Could not start FastConformer worker')
      }
    })
    return this.startPromise
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.stopChild()
    return this.shutdownPromise
  }

  private readStdout(chunk: Buffer): void {
    if (!this.startup) {
      if (this.ready && /\S/.test(chunk.toString())) this.fail('FastConformer worker sent unsolicited output')
      return
    }
    this.stdout += chunk.toString()
    if (Buffer.byteLength(this.stdout) > MAX_STDOUT_BYTES) {
      this.fail('FastConformer worker exceeded startup output limit')
      return
    }
    const newline = this.stdout.indexOf('\n')
    if (newline < 0) return
    const line = this.stdout.slice(0, newline)
    try {
      parseReady(line, this.config.expectedSha256)
    } catch (error) {
      const message = error instanceof FastConformerProtocolError && error.code === 'INVALID_LINE'
        ? 'FastConformer worker returned malformed startup output'
        : 'FastConformer worker reported an unexpected model identity'
      this.fail(message)
      return
    }
    if (/\S/.test(this.stdout.slice(newline + 1))) {
      this.fail('FastConformer worker sent unsolicited startup output')
      return
    }
    const startup = this.startup
    this.startup = undefined
    this.stdout = ''
    this.ready = true
    clearTimeout(startup.timer)
    startup.resolve()
  }

  private fail(message: string): void {
    const startup = this.startup
    if (!startup) {
      if (this.ready) {
        this.ready = false
        void this.shutdown()
      }
      return
    }
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
      startup.reject(new Error('FastConformer startup cancelled'))
    }
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
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), delay) })
    const result = await Promise.race([closed.then(() => true), timedOut])
    if (timer) clearTimeout(timer)
    return result
  }
}
