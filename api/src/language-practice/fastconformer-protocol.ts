import { isAbsolute } from 'node:path'

export const FASTCONFORMER_MODEL_ID = 'nvidia/stt_en_fastconformer_hybrid_large_pc'
export const FASTCONFORMER_NO_SPEECH_CODE = 'LANGUAGE_PRACTICE_NO_SPEECH'
export const MAX_PROTOCOL_LINE_BYTES = 8_192

export type ProtocolErrorCode =
  | 'INVALID_LINE'
  | 'LINE_TOO_LARGE'
  | 'UNEXPECTED_MESSAGE'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_REQUEST'
  | 'INVALID_RESULT'

const errorMessages: Record<ProtocolErrorCode, string> = {
  INVALID_LINE: 'Invalid protocol line',
  LINE_TOO_LARGE: 'Protocol line exceeds limit',
  UNEXPECTED_MESSAGE: 'Unexpected protocol message',
  IDENTITY_MISMATCH: 'Protocol identity mismatch',
  INVALID_REQUEST: 'Invalid protocol request',
  INVALID_RESULT: 'Invalid protocol result',
}

export class FastConformerProtocolError extends Error {
  constructor(readonly code: ProtocolErrorCode) {
    super(errorMessages[code])
    this.name = 'FastConformerProtocolError'
  }
}

type RecordValue = Record<string, unknown>

function fail(code: ProtocolErrorCode): never {
  throw new FastConformerProtocolError(code)
}

function parseObject(line: string): RecordValue {
  if (typeof line !== 'string') return fail('INVALID_LINE')
  if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) return fail('LINE_TOO_LARGE')
  let value: unknown
  try { value = JSON.parse(line) } catch { return fail('INVALID_LINE') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_LINE')
  return value as RecordValue
}

function hasExactKeys(value: RecordValue, keys: string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function parseReady(line: string, expectedSha: string): void {
  const value = parseObject(line)
  if (!hasExactKeys(value, ['type', 'modelId', 'modelSha256']) || value.type !== 'ready') {
    fail('UNEXPECTED_MESSAGE')
  }
  if (value.modelId !== FASTCONFORMER_MODEL_ID || value.modelSha256 !== expectedSha) {
    fail('IDENTITY_MISMATCH')
  }
}

function safeText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

export function serializeRequest(id: string, audioPath: string): string {
  if (typeof id !== 'string' || id.length < 1 || id.length > 256 || !safeText(id) ||
      typeof audioPath !== 'string' || audioPath.length < 1 || audioPath.length > 4096 ||
      !safeText(audioPath) || !isAbsolute(audioPath)) {
    fail('INVALID_REQUEST')
  }
  const line = `${JSON.stringify({ id, audioPath })}\n`
  if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) fail('INVALID_REQUEST')
  return line
}

export type FastConformerResult =
  | { type: 'result'; id: string; transcript: string }
  | { type: 'result'; id: string; code: typeof FASTCONFORMER_NO_SPEECH_CODE; error: string }

export function parseResult(line: string, expectedId: string): FastConformerResult {
  const value = parseObject(line)
  if (value.type !== 'result' || typeof value.id !== 'string' || value.id.length < 1 ||
      value.id.length > 256 || !safeText(value.id) || value.id !== expectedId) {
    fail('UNEXPECTED_MESSAGE')
  }
  if (hasExactKeys(value, ['type', 'id', 'transcript'])) {
    if (typeof value.transcript !== 'string' || value.transcript.trim().length === 0 ||
        value.transcript.length > 4_000 || !safeText(value.transcript)) {
      fail('INVALID_RESULT')
    }
    return value as FastConformerResult
  }
  if (hasExactKeys(value, ['type', 'id', 'code', 'error']) &&
      value.code === FASTCONFORMER_NO_SPEECH_CODE && typeof value.error === 'string') {
    return { type: 'result', id: expectedId, code: FASTCONFORMER_NO_SPEECH_CODE, error: 'No speech was recognized.' }
  }
  fail('INVALID_RESULT')
}
