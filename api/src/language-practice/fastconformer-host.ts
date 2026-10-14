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
const MAX_STARTUP_MS = 60_000
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

const DIAGNOSTICS = {
  startup_timeout: ['startup', 'FastConformer startup timed out'],
  startup_spawn: ['startup', 'Could not start FastConformer worker'],
  startup_process_error: ['startup', 'Could not start FastConformer worker'],
  startup_stream_error: ['startup', 'Could not start FastConformer worker'],
  startup_closed: ['startup', 'FastConformer worker closed during startup'],
  startup_output_limit: ['startup', 'FastConformer worker exceeded startup output limit'],
  startup_malformed: ['startup', 'FastConformer worker returned malformed startup output'],
  startup_identity: ['startup', 'FastConformer worker reported an unexpected model identity'],
  startup_unsolicited: ['startup', 'FastConformer worker sent unsolicited startup output'],
  startup_cancelled: ['startup', 'FastConformer startup cancelled'],
  request_timeout: ['request', 'FastConformer transcription timed out'],
  request_process_error: ['request', 'FastConformer worker failed'],
  request_stream_error: ['request', 'FastConformer worker failed'],
  request_write: ['request', 'FastConformer worker failed'],
  request_closed: ['request', 'FastConformer worker closed'],
  request_oversized: ['request', 'FastConformer worker returned an oversized response'],
  request_unsolicited: ['request', 'FastConformer worker sent unsolicited output'],
  request_invalid_response: ['request', 'FastConformer worker returned an invalid response'],
  request_invalid_path: ['request', 'Invalid absolute audio path'],
  request_busy: ['request', 'FastConformer request already in flight'],
  request_cancelled: ['request', 'FastConformer transcription cancelled'],
  host_stopped: ['lifecycle', 'FastConformer host is stopped or closed'],
  no_speech: ['request', 'No speech was recognized.'],
  preparation_input: ['preparation', 'Audio preparation failed'],
  preparation_io: ['preparation', 'Audio preparation failed'],
  preparation_spawn: ['preparation', 'Audio preparation failed'],
  preparation_process: ['preparation', 'Audio preparation failed'],
  preparation_timeout: ['preparation', 'Audio preparation failed'],
  preparation_wav: ['preparation', 'Audio preparation failed'],
  preparation_callback: ['preparation', 'Audio preparation failed'],
  preparation_cleanup: ['preparation', 'Audio preparation failed'],
} as const

export type SttDiagnosticCode = keyof typeof DIAGNOSTICS
export type SttDiagnostic = {
  code: SttDiagnosticCode
  component: 'fastconformer' | 'audio_preparation'
  phase: 'startup' | 'request' | 'lifecycle' | 'preparation'
}
// Private provenance prevents forged or mutated public error properties entering logs.
const trustedDiagnostics = new WeakMap<object, SttDiagnostic>()
export class SttDiagnosticError extends Error {
  constructor(code: SttDiagnosticCode) {
    const entry = Object.prototype.hasOwnProperty.call(DIAGNOSTICS, code) ? DIAGNOSTICS[code] : undefined
    super(entry ? entry[1] : 'STT failed')
    if (entry) trustedDiagnostics.set(this, {
      code, component: code.startsWith('preparation_') ? 'audio_preparation' : 'fastconformer', phase: entry[0],
    })
  }
}

export function getSttDiagnostic(error: unknown): SttDiagnostic | undefined {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined
  const diagnostic = trustedDiagnostics.get(error as object)
  return diagnostic ? { ...diagnostic } : undefined
}

export class FastConformerNoSpeechError extends SttDiagnosticError {
  constructor() {
    super('no_speech')
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
  private stopped = false
  private closed = false
  private ready = false
  private replacementEligible = false
  private replacementUsed = false

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
    if (this.stopped || this.shutdownPromise || this.closed) return Promise.reject(new SttDiagnosticError('host_stopped'))
    if (this.startPromise) return this.startPromise
    this.startPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail('startup_timeout'), this.config.startupTimeoutMs)
      this.startup = { resolve, reject, timer }
      try {
        const child = this.spawnChild(this.config.pythonExecutable, [
          this.config.workerPath, '--model-path', this.config.modelPath,
          '--model-sha256', this.config.expectedSha256,
        ], { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        this.child = child
        const onStreamError = () => {
          if (this.child !== child) return
          if (this.startup) this.fail('startup_stream_error')
          else if (this.pendingRequest) this.failRequest('request_stream_error')
          else if (this.ready) {
            this.ready = false
            void this.shutdown()
          }
        }
        child.stdout?.on('error', onStreamError)
        child.stderr?.on('error', onStreamError)
        child.stdin?.on('error', () => {
          if (this.child !== child) return
          if (this.startup) this.fail('startup_stream_error')
          else if (this.pendingRequest) this.failRequest('request_stream_error')
          else if (this.ready) {
            this.ready = false
            void this.shutdown()
          }
        })
        child.stdout?.on('data', (chunk: Buffer) => {
          if (this.child === child) this.readStdout(chunk)
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          if (this.child === child) this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR_BYTES)
        })
        child.once('error', () => {
          if (this.child !== child) return
          if (this.startup) this.fail('startup_process_error')
          else if (this.pendingRequest) this.failRequest('request_process_error')
          else if (this.ready) {
            this.ready = false
            void this.shutdown()
          }
        })
        child.once('close', () => {
          if (this.child !== child) return
          const wasReady = this.ready
          this.closed = true
          this.ready = false
          if (this.startup) this.fail('startup_closed')
          else {
            // Startup failure eligibility survives cleanup's close event.
            if (wasReady) this.replacementEligible = !this.stopped && !this.shutdownPromise
            if (this.pendingRequest) {
              const request = this.pendingRequest
              this.clearPendingRequest(request)
              request.reject(new SttDiagnosticError('request_closed'))
              this.responseBuffer = Buffer.alloc(0)
            }
          }
        })
      } catch {
        this.fail('startup_spawn')
      }
    })
    return this.startPromise
  }

  transcribe(audioPath: string): Promise<string> {
    if (this.stopped || (this.shutdownPromise && !this.replacementEligible)) {
      return Promise.reject(new SttDiagnosticError('host_stopped'))
    }
    if (this.pendingRequest) return Promise.reject(new SttDiagnosticError('request_busy'))
    if (typeof audioPath !== 'string' || !isAbsolute(audioPath)) {
      return Promise.reject(new SttDiagnosticError('request_invalid_path'))
    }

    const id = randomUUID()
    let line: string
    try { line = serializeRequest(id, audioPath) } catch {
      return Promise.reject(new SttDiagnosticError('request_invalid_path'))
    }

    if (this.closed) {
      if (!this.replacementEligible || this.replacementUsed) {
        return Promise.reject(new SttDiagnosticError('host_stopped'))
      }
      this.replacementUsed = true
      this.replacementEligible = false
      // Only an observed close permits clearing cleanup and detaching the old child.
      this.child = undefined
      this.shutdownPromise = undefined
      this.startPromise = undefined
      this.closed = false
      this.stdout = ''
      this.responseBuffer = Buffer.alloc(0)
      this.stderr = ''
    }
    if (this.startPromise && !this.ready && !this.startup) {
      return Promise.reject(new SttDiagnosticError('host_stopped'))
    }
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_MS
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectRequest(id, new SttDiagnosticError('request_timeout'))
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
        this.failRequest('request_write')
      }
    }).catch((error: unknown) => {
      this.rejectRequest(id, getSttDiagnostic(error) ? error as Error : new SttDiagnosticError('startup_spawn'))
    })
    return promise
  }

  shutdown(): Promise<void> {
    this.stopped = true
    this.replacementEligible = false
    return this.cleanupChild()
  }

  private cleanupChild(): Promise<void> {
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
      this.fail('startup_output_limit')
      return
    }
    const newline = this.stdout.indexOf('\n')
    if (newline < 0) return
    const line = this.stdout.slice(0, newline)
    try {
      parseReady(line, this.config.expectedSha256)
    } catch (error) {
      this.fail(error instanceof FastConformerProtocolError && error.code === 'INVALID_LINE'
        ? 'startup_malformed' : 'startup_identity')
      return
    }
    if (/\S/.test(this.stdout.slice(newline + 1))) {
      this.fail('startup_unsolicited')
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
      if (chunk.length > 0) this.fail('request_unsolicited')
      return
    }
    this.responseBuffer = Buffer.concat([this.responseBuffer, chunk])
    const newline = this.responseBuffer.indexOf(0x0a)
    const lineBytes = newline < 0 ? this.responseBuffer.length : newline
    if (lineBytes > MAX_PROTOCOL_LINE_BYTES || (newline < 0 && lineBytes > MAX_STDOUT_BYTES)) {
      this.failRequest('request_oversized')
      return
    }
    if (newline < 0) return
    if (newline + 1 !== this.responseBuffer.length) {
      this.failRequest('request_unsolicited')
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
      this.failRequest('request_invalid_response')
    }
  }

  private fail(code: SttDiagnosticCode): void {
    const startup = this.startup
    if (!startup) {
      if (this.ready) {
        this.ready = false
        this.failRequest(code)
        void this.shutdown()
      }
      return
    }
    this.startup = undefined
    clearTimeout(startup.timer)
    const error = new SttDiagnosticError(code)
    startup.reject(error)
    // Reject before shutdown can replace the startup reason with cancellation.
    if (this.pendingRequest) this.rejectRequest(this.pendingRequest.id, error)
    this.replacementEligible = !this.stopped && !this.replacementUsed
    void this.cleanupChild()
  }

  private failRequest(code: SttDiagnosticCode): void {
    if (!this.pendingRequest) return
    this.rejectRequest(this.pendingRequest.id, new SttDiagnosticError(code))
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
      startup.reject(new SttDiagnosticError('startup_cancelled'))
    }
    const pending = this.pendingRequest
    if (pending) {
      this.clearPendingRequest(pending)
      pending.reject(new SttDiagnosticError('request_cancelled'))
    }
    this.ready = false
    const child = this.child
    if (!child || this.closed) return
    const closed = new Promise<void>((resolve) => child.once('close', () => {
      if (this.child === child) this.closed = true
      resolve()
    }))
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
