import { createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'

export type PiperVoice = 'en' | 'es'

const MAX_SIDECAR_BYTES = 128 * 1024
const MAX_MODEL_BYTES = 1024 * 1024 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GENERIC_ERROR = 'Invalid Piper artifact'

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

function isMetadata(value: object): value is FileMetadata {
  return 'dev' in value && 'ino' in value && 'mode' in value && 'size' in value &&
    'mtimeNs' in value && 'ctimeNs' in value
}

async function openVerifiedFile(filePath: string): Promise<{ handle: FileHandle; metadata: FileMetadata }> {
  const before = await lstat(filePath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(GENERIC_ERROR)

  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameMetadata(before, opened) || !isMetadata(opened)) {
      throw new Error(GENERIC_ERROR)
    }
    return { handle, metadata: opened }
  } catch (error) {
    await handle.close()
    throw error
  }
}

function safeEqual(actualHex: string, expectedHex: string): boolean {
  const actual = Buffer.from(actualHex, 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function validatePathAndDigests(modelPath: string, modelSha256: string, sidecarSha256: string): void {
  if (typeof modelPath !== 'string' || !isAbsolute(modelPath) || modelPath.includes('\0') ||
      modelPath.split(sep).includes('..') || !modelPath.endsWith('.onnx') ||
      typeof modelSha256 !== 'string' || !SHA256_PATTERN.test(modelSha256) ||
      typeof sidecarSha256 !== 'string' || !SHA256_PATTERN.test(sidecarSha256)) {
    throw new Error(GENERIC_ERROR)
  }
}

async function readBoundedSidecar(handle: FileHandle): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_SIDECAR_BYTES + 1)
  let length = 0
  while (length < bytes.length) {
    const result = await handle.read(bytes, length, bytes.length - length, length)
    if (result.bytesRead === 0) break
    length += result.bytesRead
  }
  if (length === 0 || length > MAX_SIDECAR_BYTES) throw new Error(GENERIC_ERROR)
  return bytes.subarray(0, length)
}

function validSidecarJson(bytes: Buffer): boolean {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

/** Verifies injected Piper artifacts without starting a Piper process. */
export async function verifyPiperArtifact(
  voice: PiperVoice,
  modelPath: string,
  modelSha256: string,
  sidecarSha256: string,
): Promise<void> {
  try {
    if (voice !== 'en' && voice !== 'es') throw new Error(GENERIC_ERROR)
    validatePathAndDigests(modelPath, modelSha256, sidecarSha256)

    const modelFile = await openVerifiedFile(modelPath)
    let sidecarFile: Awaited<ReturnType<typeof openVerifiedFile>> | undefined
    try {
      sidecarFile = await openVerifiedFile(`${modelPath}.json`)
      if (modelFile.metadata.size > BigInt(MAX_MODEL_BYTES) ||
          sidecarFile.metadata.size > BigInt(MAX_SIDECAR_BYTES)) throw new Error(GENERIC_ERROR)

      const sidecarBytes = await readBoundedSidecar(sidecarFile.handle)
      const sidecarAfter = await sidecarFile.handle.stat({ bigint: true })
      if (!sameMetadata(sidecarFile.metadata, sidecarAfter) || !validSidecarJson(sidecarBytes)) {
        throw new Error(GENERIC_ERROR)
      }

      const modelHash = createHash('sha256')
      const stream = modelFile.handle.createReadStream({ autoClose: false })
      let modelBytes = 0
      for await (const chunk of stream) {
        const bytes = chunk as Buffer
        modelBytes += bytes.length
        if (modelBytes > MAX_MODEL_BYTES) throw new Error(GENERIC_ERROR)
        modelHash.update(bytes)
      }
      const modelAfter = await modelFile.handle.stat({ bigint: true })
      if (modelBytes === 0 || !sameMetadata(modelFile.metadata, modelAfter)) throw new Error(GENERIC_ERROR)

      const modelMatches = safeEqual(modelHash.digest('hex'), modelSha256)
      const sidecarMatches = safeEqual(createHash('sha256').update(sidecarBytes).digest('hex'), sidecarSha256)
      if (!modelMatches || !sidecarMatches) throw new Error(GENERIC_ERROR)
    } finally {
      await modelFile.handle.close()
      if (sidecarFile) await sidecarFile.handle.close()
    }
  } catch {
    throw new Error(GENERIC_ERROR)
  }
}
