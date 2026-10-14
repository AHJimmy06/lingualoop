const sharp = require('sharp') as typeof import('sharp').default;

export const MAX_PRACTICE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_ACTIVE = 2;
let active = 0;
const normalized = new WeakSet<object>();
export interface NormalizedPracticeImage { readonly bytes: Buffer; readonly mime: 'image/jpeg' }
export class PracticeImageBusyError extends Error {
  constructor() { super('Practice image processing busy.'); }
}
export function isNormalizedPracticeImage(value: unknown): value is NormalizedPracticeImage {
  return typeof value === 'object' && value !== null && normalized.has(value);
}

/** Reject container truncation/animation before decoding; never trust upload MIME alone. */
function containerFormat(bytes: Buffer): 'jpeg' | 'png' | 'webp' {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    // Walk markers (not metadata contents) to reject concatenated JPEGs and trailing data.
    let offset = 2;
    let scan = false;
    while (offset < bytes.length) {
      if (scan && bytes[offset] !== 0xff) { offset += 1; continue; }
      if (bytes[offset++] !== 0xff) throw new TypeError();
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9) {
        if (offset !== bytes.length) throw new TypeError();
        return 'jpeg';
      }
      if (scan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
      if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) throw new TypeError();
      if (marker === 1) continue;
      if (offset + 2 > bytes.length) throw new TypeError();
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) throw new TypeError();
      offset += size;
      scan = marker === 0xda;
    }
    throw new TypeError();
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset);
      const end = offset + 12 + size;
      if (end > bytes.length) throw new TypeError();
      const chunk = bytes.toString('ascii', offset + 4, offset + 8);
      if (['acTL', 'fcTL', 'fdAT'].includes(chunk)) throw new TypeError();
      if (chunk === 'IEND') {
        if (size !== 0 || end !== bytes.length) throw new TypeError();
        return 'png';
      }
      offset = end;
    }
    throw new TypeError();
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new TypeError();
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunk = bytes.toString('ascii', offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      if (['ANIM', 'ANMF'].includes(chunk) || (chunk === 'VP8X' && size > 0 && (bytes[offset + 8] & 2))) throw new TypeError();
      offset += 8 + size + (size % 2);
      if (offset > bytes.length) throw new TypeError();
    }
    if (offset !== bytes.length) throw new TypeError();
    return 'webp';
  }
  throw new TypeError();
}

/** No paths, URLs, metadata retention, queues or external services. */
export async function normalizePracticeImage(bytes: Buffer, mime: string): Promise<NormalizedPracticeImage> {
  if (active >= MAX_ACTIVE) throw new PracticeImageBusyError();
  active += 1;
  try {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PRACTICE_IMAGE_BYTES) throw new TypeError();
    const format = containerFormat(bytes);
    if (mime !== `image/${format}`) throw new TypeError();
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true });
    const metadata = await decoder.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height ||
        metadata.width > 4096 || metadata.height > 4096 || metadata.width * metadata.height > MAX_PIXELS ||
        (metadata.pages ?? 1) !== 1) throw new TypeError();
    // Sharp strips metadata by default. Decode all pixels, orient and flatten transparency.
    const output = await decoder.rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 80 })
      .timeout({ seconds: 5 }).toBuffer();
    if (!output.length || output.length > MAX_PRACTICE_IMAGE_BYTES) throw new TypeError();
    const result: NormalizedPracticeImage = Object.freeze({ bytes: output, mime: 'image/jpeg' });
    normalized.add(result);
    return result;
  } catch { throw new TypeError('Invalid practice image.'); }
  finally { active -= 1; }
}
