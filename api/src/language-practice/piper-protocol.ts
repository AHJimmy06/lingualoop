import { isAbsolute } from 'node:path'

export const MAX_PIPER_REQUEST_BYTES = 16 * 1024
export const MAX_PIPER_RESPONSE_BYTES = 8 * 1024
export const MAX_PIPER_PATH_BYTES = 4 * 1024

export class PiperProtocolError extends Error {
  constructor() {
    super('Invalid Piper protocol data')
    this.name = 'PiperProtocolError'
  }
}

function fail(): never {
  throw new PiperProtocolError()
}

function hasSafeUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 &&
    Buffer.byteLength(path, 'utf8') <= MAX_PIPER_PATH_BYTES &&
    hasSafeUnicode(path) && isAbsolute(path)
}

export function serializePiperRequest(text: string, outputPath: string): string {
  if (typeof text !== 'string' || text.trim().length === 0 || !hasSafeUnicode(text) ||
      Buffer.byteLength(text, 'utf8') > MAX_PIPER_REQUEST_BYTES || !validPath(outputPath)) {
    return fail()
  }

  const json = JSON.stringify({ text, output_file: outputPath })
  if (Buffer.byteLength(json, 'utf8') > MAX_PIPER_REQUEST_BYTES) return fail()
  return `${json}\n`
}

export function parsePiperResponse(line: string, expectedPath: string): void {
  if (typeof line !== 'string' || !validPath(expectedPath) ||
      Buffer.byteLength(line, 'utf8') > MAX_PIPER_RESPONSE_BYTES || line.includes('\n')) {
    return fail()
  }

  const echoedPath = line.endsWith('\r') ? line.slice(0, -1) : line
  if (echoedPath !== expectedPath) return fail()
}
