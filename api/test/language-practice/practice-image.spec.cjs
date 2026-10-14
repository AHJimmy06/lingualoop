const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const image = () => require('../../dist/language-practice/practice-image.js');
const raster = (format, width = 8, height = 6) => sharp({ create: { width, height, channels: 3, background: '#357abc' } }).toFormat(format).toBuffer();

test('local sharp decodes JPEG PNG WebP and strips metadata in bounded JPEG output', async () => {
  for (const format of ['jpeg', 'png', 'webp']) {
    const bytes = await sharp(await raster(format)).withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const result = await image().normalizePracticeImage(bytes, `image/${format}`);
    assert.equal(result.mime, 'image/jpeg');
    assert.ok(result.bytes.length <= 2 * 1024 * 1024);
    const metadata = await sharp(result.bytes).metadata();
    assert.equal(metadata.format, 'jpeg');
    for (const key of ['exif', 'icc', 'iptc', 'xmp', 'orientation']) assert.equal(metadata[key], undefined);
    assert.equal(image().isNormalizedPracticeImage(result), true);
  }
});

test('rejects faked MIME/signature, truncation, SVG, GIF, oversized input and dimensions', async () => {
  const jpeg = await raster('jpeg');
  const png = await raster('png');
  const webp = await raster('webp');
  const bad = [
    [jpeg, 'image/png'], [png, 'image/jpeg'], [webp, 'text/plain'], [Buffer.concat([jpeg, jpeg]), 'image/jpeg'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>'), 'image/png'],
    [await raster('gif'), 'image/png'], [Buffer.from('GIF89a'), 'image/jpeg'],
    [Buffer.concat([jpeg, Buffer.alloc(2 * 1024 * 1024)]), 'image/jpeg'],
    [await raster('png', 4097, 1), 'image/png'], [await raster('png', 4096, 4096), 'image/png'],
    [Buffer.alloc(0), 'image/jpeg'], [Buffer.from([255, 216, 0, 1, 2, 255, 217]), 'image/jpeg'],
    [Buffer.concat([jpeg.subarray(0, Math.floor(jpeg.length / 2)), Buffer.from([255, 217])]), 'image/jpeg'],
  ];
  for (const [bytes, mime] of [[jpeg, 'image/jpeg'], [png, 'image/png'], [webp, 'image/webp']]) {
    bad.push([bytes.subarray(0, bytes.length - 10), mime]);
    bad.push([bytes.subarray(0, Math.floor(bytes.length / 2)), mime]);
  }
  for (const [bytes, mime] of bad) await assert.rejects(image().normalizePracticeImage(bytes, mime), /Invalid practice image/);
  assert.equal(image().isNormalizedPracticeImage({ bytes: jpeg, mime: 'image/jpeg' }), false);
});

test('rejects actual animated PNG/WebP even with allowed MIME', async () => {
  const frames = Buffer.alloc(8 * 12 * 3, 180);
  frames.fill(30, 8 * 6 * 3);
  const animated = await sharp(frames, { raw: { width: 8, height: 12, channels: 3, pageHeight: 6 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(image().normalizePracticeImage(animated, 'image/webp'), /Invalid practice image/);
  // Valid APNG container with CRC-correct controls and two raster frames; some decoders expose only frame one.
  function chunk(type, data) {
    const output = Buffer.alloc(data.length + 12); output.writeUInt32BE(data.length); output.write(type, 4); data.copy(output, 8);
    let crc = 0xffffffff;
    for (const byte of output.subarray(4, output.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  }
  function frameControl(sequence) {
    const data = Buffer.alloc(26); data.writeUInt32BE(sequence); data.writeUInt32BE(8, 4); data.writeUInt32BE(6, 8);
    data.writeUInt16BE(1, 20); data.writeUInt16BE(10, 22);
    return chunk('fcTL', data);
  }
  const png = await raster('png');
  const second = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'red' } }).png().toBuffer();
  function idat(bytes) {
    const parts = [];
    for (let offset = 8; offset < bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + size));
      offset += size + 12;
    }
    return Buffer.concat(parts);
  }
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2);
  const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
  const apng = Buffer.concat([png.subarray(0, 33), chunk('acTL', animation), frameControl(0), chunk('IDAT', idat(png)), frameControl(1), chunk('fdAT', Buffer.concat([sequence, idat(second)])), chunk('IEND', Buffer.alloc(0))]);
  assert.equal((await sharp(apng).metadata()).width, 8);
  await sharp(apng, { failOn: 'warning' }).raw().toBuffer();
  await assert.rejects(image().normalizePracticeImage(apng, 'image/png'), /Invalid practice image/);
});

test('accepts axis boundary, and rejects a decoded cover whose normalized JPEG exceeds 2 MiB', async () => {
  const boundary = await image().normalizePracticeImage(await raster('png', 4096, 1), 'image/png');
  assert.equal((await sharp(boundary.bytes).metadata()).width, 4096);
  const raw = Buffer.alloc(4000 * 4000 * 3);
  let state = 123;
  for (let i = 0; i < raw.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; raw[i] = state & 255; }
  const input = await sharp(raw, { raw: { width: 4000, height: 4000, channels: 3 } }).jpeg({ quality: 10 }).toBuffer();
  assert.ok(input.length <= 2 * 1024 * 1024, 'fixture meets input limit');
  const output = await sharp(input).jpeg({ quality: 80 }).toBuffer();
  assert.ok(output.length > 2 * 1024 * 1024, 'fixture exercises output limit');
  await assert.rejects(image().normalizePracticeImage(input, 'image/jpeg'), /Invalid practice image/);
});

test('processing slots are bounded and released after decoder errors', async () => {
  const bytes = await raster('png', 1024, 1024);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => image().normalizePracticeImage(bytes, 'image/png')));
  assert.ok(results.some(result => result.status === 'rejected' && /busy/i.test(result.reason.message)));
  assert.ok(results.some(result => result.status === 'fulfilled'));
  await assert.rejects(image().normalizePracticeImage(Buffer.from('bad'), 'image/jpeg'));
  await image().normalizePracticeImage(await raster('png'), 'image/png');
});
