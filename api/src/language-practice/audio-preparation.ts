import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { chmod, lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { getSttDiagnostic, SttDiagnosticError } from './fastconformer-host'
import type { SttDiagnosticCode } from './fastconformer-host'

const MAX_INPUT_BYTES = 2 * 1024 * 1024
const PROCESS_TIMEOUT_MS = 30_000
const TERM_GRACE_MS = 250
const KILL_GRACE_MS = 500
const MAX_STDERR_BYTES = 8 * 1024
const MAX_WAV_BYTES = 1024 * 1024
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/webm': '.webm',
  'audio/webm;codecs=opus': '.webm',
  'audio/ogg': '.ogg',
  'audio/ogg;codecs=opus': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
}

type SpawnChild = (command: string, args: string[], options: SpawnOptions) => ChildProcess
type PreparedAudioOptions = {
  ffmpegExecutable: string
  tempRoot?: string
  spawnChild?: SpawnChild
  timeoutMs?: number
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return } catch { /* use child signal */ }
  }
  try { child.kill(signal) } catch { /* process already exited */ }
}

function runFFmpeg(command: string, inputPath: string, outputPath: string, spawnChild: SpawnChild, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-y', '-i', inputPath, '-t', '20', '-c:a', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-f', 'wav', outputPath]
    let child: ChildProcess
    try {
      child = spawnChild(command, args, {
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
    } catch {
      reject(new SttDiagnosticError('preparation_spawn'))
      return
    }

    let settled = false
    let failure: SttDiagnosticCode | undefined
    let stderrTail = Buffer.alloc(0)
    let killTimer: NodeJS.Timeout | undefined
    let closeTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      failure ??= 'preparation_timeout'
      signalTree(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        signalTree(child, 'SIGKILL')
        closeTimer = setTimeout(() => finish(), KILL_GRACE_MS)
      }, TERM_GRACE_MS)
    }, timeoutMs)
    const clearTimers = () => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      if (closeTimer) clearTimeout(closeTimer)
    }
    const finish = (ok = false) => {
      if (settled) return
      settled = true
      clearTimers()
      stderrTail = Buffer.alloc(0)
      if (ok && !failure) resolve()
      else reject(new SttDiagnosticError(failure ?? 'preparation_process'))
    }

    const stopChild = () => {
      if (settled) return
      failure ??= 'preparation_process'
      signalTree(child, 'SIGTERM')
      if (!killTimer) killTimer = setTimeout(() => {
        signalTree(child, 'SIGKILL')
        closeTimer = setTimeout(() => finish(), KILL_GRACE_MS)
      }, TERM_GRACE_MS)
    }
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stderrTail = Buffer.concat([stderrTail, bytes]).subarray(-MAX_STDERR_BYTES)
    })
    child.stderr?.once('error', stopChild)
    child.once('error', stopChild)
    child.once('exit', (code: number | null) => {
      if (code !== 0) failure ??= 'preparation_process'
    })
    child.once('close', (code: number | null) => finish(code === 0))
  })
}

async function validateWav(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.size <= 44 || info.size > MAX_WAV_BYTES) throw new Error('invalid')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await file.stat()
    const contents = Buffer.alloc(MAX_WAV_BYTES + 1)
    let length = 0
    while (length < contents.length) {
      const { bytesRead } = await file.read(contents, length, contents.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const wav = contents.subarray(0, length)
    if (!actual.isFile() || actual.size !== info.size || length !== actual.size || length > MAX_WAV_BYTES ||
        length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' ||
        wav.readUInt32LE(4) !== length - 8) throw new Error('invalid')
    let offset = 12
    let hasFormat = false
    let hasData = false
    while (offset < length) {
      if (length - offset < 8) throw new Error('invalid')
      const id = wav.toString('ascii', offset, offset + 4)
      const size = wav.readUInt32LE(offset + 4)
      const start = offset + 8
      const end = start + size
      const next = end + (size & 1)
      if (end > length || next > length) throw new Error('invalid')
      if (id === 'fmt ') {
        if (hasFormat || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 ||
            wav.readUInt32LE(start + 4) !== 16000 || wav.readUInt32LE(start + 8) !== 32000 ||
            wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) throw new Error('invalid')
        hasFormat = true
      } else if (id === 'data') {
        if (!hasFormat || hasData || size === 0 || size > 640_000 || size % 2 !== 0) throw new Error('invalid')
        hasData = true
      }
      offset = next
    }
    if (offset !== length || !hasFormat || !hasData) throw new Error('invalid')
  } finally { await file.close() }
}

/** Prepare bounded caller-owned audio and keep its private WAV available only during callback. */
export async function withPreparedAudio<T>(
  input: Buffer,
  mimeType: string,
  callback: (absoluteWavPath: string) => Promise<T> | T,
  options: PreparedAudioOptions,
): Promise<T> {
  const extension = typeof mimeType === 'string' ? MIME_EXTENSIONS[mimeType] : undefined
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > MAX_INPUT_BYTES || !extension ||
      typeof callback !== 'function' || !options || typeof options.ffmpegExecutable !== 'string' ||
      options.ffmpegExecutable.length === 0 || options.ffmpegExecutable.includes('\0') ||
      (options.tempRoot !== undefined && (typeof options.tempRoot !== 'string' || !isAbsolute(options.tempRoot))) ||
      (options.spawnChild !== undefined && typeof options.spawnChild !== 'function') ||
      (options.timeoutMs !== undefined &&
        (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > PROCESS_TIMEOUT_MS))) {
    throw new SttDiagnosticError('preparation_input')
  }

  let directory: string | undefined
  let failureCode: SttDiagnosticCode = 'preparation_io'
  try {
    directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'lingualoop-audio-'))
    await chmod(directory, 0o700)
    const inputPath = join(directory, `input${extension}`)
    const outputPath = join(directory, 'prepared.wav')
    await writeFile(inputPath, input, { flag: 'wx', mode: 0o600 })
    await runFFmpeg(options.ffmpegExecutable, inputPath, outputPath, options.spawnChild ?? spawn,
      options.timeoutMs ?? PROCESS_TIMEOUT_MS)
    failureCode = 'preparation_wav'
    await validateWav(outputPath)
    failureCode = 'preparation_callback'
    return await callback(outputPath)
  } catch (error) {
    if (getSttDiagnostic(error)) throw error
    throw new SttDiagnosticError(failureCode)
  } finally {
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }) } catch { throw new SttDiagnosticError('preparation_cleanup') }
    }
  }
}
