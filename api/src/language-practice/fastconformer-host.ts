import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  FASTCONFORMER_MODEL_ID,
  FASTCONFORMER_NO_SPEECH_CODE,
  FastConformerProtocolError,
  MAX_PROTOCOL_LINE_BYTES,
  parseReady,
  parseResult,
  serializeRequest,
} from './fastconformer-protocol'

export { FASTCONFORMER_MODEL_ID } from './fastconformer-protocol'
const MAX_STARTUP_MS = 30_000
const MAX_STDOUT_BYTES = 8_192
const MAX_STDERR_BYTES = 4_000
const MAX_REQUEST_MS = 90_000
const DEFAULT_REQUEST_MS = 90_000
const TERM_GRACE_MS = 1_500
const KILL_GRACE_MS = 250

type HostConfig = {
  pythonExecutable: string
  workerPath: string
  modelPath: string
  expectedSha256: string
  startupTimeoutMs: number
  requestTimeoutMs?: number
}
type SpawnChild = (executable: string, args: string[], options: SpawnOptions) => ChildProcess
export type ProcessTreeSignal = (child: ChildProcess, signal: NodeJS.Signals) => void

type PendingRequest = {
  id: string
  resolve: (transcript: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class FastConformerNoSpeechError extends Error {
  constructor() {
    super('No speech was recognized.')
    this.name = 'FastConformerNoSpeechError'
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return } catch { /* fall through to child */ }
  }
  try { child.kill(signal) } catch { /* already exited */ }
}

export class FastConformerHost {
  private child?: ChildProcess
  private startup?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  private pendingRequest?: PendingRequest
  private startPromise?: Promise<void>
  private shutdownPromise?: Promise<void>
  private stdout = ''
  private responseBuffer = Buffer.alloc(0)
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
        config.startupTimeoutMs > MAX_STARTUP_MS ||
        (config.requestTimeoutMs !== undefined &&
          (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1 || config.requestTimeoutMs > MAX_REQUEST_MS))) {
      throw new Error('Invalid FastConformer host configuration')
    }
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.shutdownPromise || this.closed) return Promise.reject(new Error('FastConformer host is stopped'))
    this.startPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail('FastConformer startup timed out'), this.config.startupTimeoutMs)
      this.startup = { resolve, reject, timer }
      try {
        const child = this.spawnChild(this.config.pythonExecutable, [
          this.config.workerPath, '--model-path', this.config.modelPath,
          '--model-sha256', this.config.expectedSha256,
        ], { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        this.child = child
        child.stdin?.on('error', () => {
          if (this.startup) this.fail('Could not start FastConformer worker')
          else if (this.pendingRequest) this.failRequest('FastConformer worker failed')
          else if (this.ready) {
            this.ready = false
            void this.shutdown()
          }
        })
        child.stdout?.on('data', (chunk: Buffer) => this.readStdout(chunk))
        child.stderr?.on('data', (chunk: Buffer) => {
          this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR_BYTES)
        })
        child.once('error', () => {
          if (this.startup) this.fail('Could not start FastConformer worker')
          else this.failRequest('FastConformer worker failed')
        })
        child.once('close', () => {
          this.closed = true
          this.ready = false
          if (this.startup) this.fail('FastConformer worker closed during startup')
          else this.failRequest('FastConformer worker closed')
        })
      } catch {
        this.fail('Could not start FastConformer worker')
      }
    })
    return this.startPromise
  }

  transcribe(audioPath: string): Promise<string> {
    if (this.shutdownPromise || this.closed || (this.startPromise && !this.ready && !this.startup)) {
      return Promise.reject(new Error('FastConformer host is stopped or closed'))
    }
    if (this.pendingRequest) return Promise.reject(new Error('FastConformer request already in flight'))
    if (typeof audioPath !== 'string' || !isAbsolute(audioPath)) {
      return Promise.reject(new Error('Invalid absolute audio path'))
    }

    const id = randomUUID()
    let line: string
    try { line = serializeRequest(id, audioPath) } catch {
      return Promise.reject(new Error('Invalid absolute audio path'))
    }

    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_MS
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectRequest(id, new Error('FastConformer transcription timed out'))
        void this.shutdown()
      }, timeoutMs)
      this.pendingRequest = { id, resolve, reject, timer }
    })

    void this.start().then(() => {
      const pending = this.pendingRequest
      if (!pending || pending.id !== id) return
      try {
        if (!this.child?.stdin || this.closed) throw new Error('closed')
        this.child.stdin.write(line)
      } catch {
        this.failRequest('FastConformer worker failed')
      }
    }).catch(() => {
      this.rejectRequest(id, new Error('FastConformer worker failed to start'))
    })
    return promise
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.stopChild()
    return this.shutdownPromise
  }

  private readStdout(chunk: Buffer): void {
    if (!this.startup) {
      if (!this.ready) return
      this.readResponse(chunk)
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

  private readResponse(chunk: Buffer): void {
    if (!this.pendingRequest) {
      if (chunk.length > 0) this.fail('FastConformer worker sent unsolicited output')
      return
    }
    this.responseBuffer = Buffer.concat([this.responseBuffer, chunk])
    const newline = this.responseBuffer.indexOf(0x0a)
    const lineBytes = newline < 0 ? this.responseBuffer.length : newline
    if (lineBytes > MAX_PROTOCOL_LINE_BYTES || (newline < 0 && lineBytes > MAX_STDOUT_BYTES)) {
      this.failRequest('FastConformer worker returned an oversized response')
      return
    }
    if (newline < 0) return
    if (newline + 1 !== this.responseBuffer.length) {
      this.failRequest('FastConformer worker sent unsolicited output')
      return
    }

    const request = this.pendingRequest
    if (!request) return
    try {
      const result = parseResult(this.responseBuffer.subarray(0, newline).toString('utf8'), request.id)
      this.clearPendingRequest(request)
      this.responseBuffer = Buffer.alloc(0)
      if ('code' in result && result.code === FASTCONFORMER_NO_SPEECH_CODE) request.reject(new FastConformerNoSpeechError())
      else if ('transcript' in result) request.resolve(result.transcript)
    } catch {
      this.failRequest('FastConformer worker returned an invalid response')
    }
  }

  private fail(message: string): void {
    const startup = this.startup
    if (!startup) {
      if (this.ready) {
        this.ready = false
        this.failRequest(message)
        void this.shutdown()
      }
      return
    }
    this.startup = undefined
    clearTimeout(startup.timer)
    startup.reject(new Error(message))
    void this.shutdown()
  }

  private failRequest(message: string): void {
    if (!this.pendingRequest) return
    this.rejectRequest(this.pendingRequest.id, new Error(message))
    this.ready = false
    this.responseBuffer = Buffer.alloc(0)
    void this.shutdown()
  }

  private rejectRequest(id: string, error: Error): void {
    const request = this.pendingRequest
    if (!request || request.id !== id) return
    this.clearPendingRequest(request)
    request.reject(error)
  }

  private clearPendingRequest(request: PendingRequest): void {
    if (this.pendingRequest === request) this.pendingRequest = undefined
    clearTimeout(request.timer)
  }

  private async stopChild(): Promise<void> {
    const startup = this.startup
    if (startup) {
      this.startup = undefined
      clearTimeout(startup.timer)
      startup.reject(new Error('FastConformer startup cancelled'))
    }
    const pending = this.pendingRequest
    if (pending) {
      this.clearPendingRequest(pending)
      pending.reject(new Error('FastConformer transcription cancelled'))
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
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), delay) })
    const result = await Promise.race([closed.then(() => true), timedOut])
    if (timer) clearTimeout(timer)
    return result
  }
}
