import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const MAX_WAV_BYTES = 8 * 1024 * 1024
const GENERIC_ERROR = 'Invalid Piper WAV'

type FileMetadata = {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

function sameMetadata(left: FileMetadata, right: FileMetadata): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function openVerifiedFile(filePath: string): Promise<{ handle: FileHandle; metadata: FileMetadata }> {
  const before = await lstat(filePath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(GENERIC_ERROR)

  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameMetadata(before, opened)) throw new Error(GENERIC_ERROR)
    return { handle, metadata: opened }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_WAV_BYTES + 1)
  let length = 0
  while (length < bytes.length) {
    const result = await handle.read(bytes, length, bytes.length - length, length)
    if (result.bytesRead === 0) break
    length += result.bytesRead
  }
  if (length === 0 || length > MAX_WAV_BYTES) throw new Error(GENERIC_ERROR)
  return bytes.subarray(0, length)
}

function isValidWav(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) !== bytes.length - 8) return false

  let offset = 12
  let formatSeen = false
  let dataSeen = false
  let channels = 0
  let sampleRate = 0
  let blockAlign = 0
  let dataSize = 0

  while (offset < bytes.length) {
    if (bytes.length - offset < 8) return false
    const chunkId = bytes.toString('ascii', offset, offset + 4)
    const chunkSize = bytes.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const paddedSize = chunkSize + (chunkSize % 2)
    if (paddedSize > bytes.length - chunkStart) return false
    const chunkEnd = chunkStart + chunkSize

    if (chunkId === 'fmt ') {
      if (formatSeen || chunkSize < 16) return false
      formatSeen = true
      const encoding = bytes.readUInt16LE(chunkStart)
      channels = bytes.readUInt16LE(chunkStart + 2)
      sampleRate = bytes.readUInt32LE(chunkStart + 4)
      const byteRate = bytes.readUInt32LE(chunkStart + 8)
      blockAlign = bytes.readUInt16LE(chunkStart + 12)
      const bitsPerSample = bytes.readUInt16LE(chunkStart + 14)
      if (encoding !== 1 || channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 96000 ||
          bitsPerSample !== 16 || blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign) return false
    } else if (chunkId === 'data') {
      if (dataSeen || chunkSize === 0) return false
      dataSeen = true
      dataSize = chunkSize
    }

    offset = chunkStart + paddedSize
    if (offset < chunkEnd) return false
  }

  return offset === bytes.length && formatSeen && dataSeen && dataSize % blockAlign === 0
}

/** Reads and validates a bounded, ordinary PCM16 Piper output WAV without starting Piper. */
export async function readValidatedPiperWav(absolutePath: string): Promise<Buffer> {
  try {
    if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath) || absolutePath.includes('\0')) {
      throw new Error(GENERIC_ERROR)
    }
    const { handle, metadata } = await openVerifiedFile(absolutePath)
    try {
      if (metadata.size === 0n || metadata.size > BigInt(MAX_WAV_BYTES)) throw new Error(GENERIC_ERROR)
      const bytes = await readBounded(handle)
      const after = await handle.stat({ bigint: true })
      if (!sameMetadata(metadata, after) || !isValidWav(bytes)) throw new Error(GENERIC_ERROR)
      return bytes
    } finally {
      await handle.close()
    }
  } catch {
    throw new Error(GENERIC_ERROR)
  }
}
