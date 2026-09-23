const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readValidatedPiperWav } = require('../../dist/language-practice/piper-wav.js');

const MAX_WAV_BYTES = 8 * 1024 * 1024;

function chunk(id, payload) {
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function formatChunk({ channels = 1, sampleRate = 22050, encoding = 1, bits = 16,
  byteRate = sampleRate * channels * 2, blockAlign = channels * 2 } = {}) {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(encoding, 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(byteRate, 8);
  format.writeUInt16LE(blockAlign, 12);
  format.writeUInt16LE(bits, 14);
  return format;
}

function wav(chunks = [chunk('fmt ', formatChunk()), chunk('data', Buffer.from([0, 0, 1, 0]))]) {
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function fixture(bytes) {
  const directory = await fs.mkdtemp(path.join(__dirname, '../../dist/.piper-wav-'));
  const filePath = path.join(directory, 'output.wav');
  await fs.writeFile(filePath, bytes);
  return { directory, filePath };
}

const genericFailure = (promise, pathHint = '') => assert.rejects(promise, (error) => {
  assert.equal(error.message, 'Invalid Piper WAV');
  if (pathHint) assert.equal(error.message.includes(pathHint), false);
  return true;
});

test('accepts PCM16 mono and stereo at supported sample rates with ancillary chunks', async () => {
  for (const [channels, sampleRate] of [[1, 8000], [1, 22050], [2, 44100], [2, 96000]]) {
    const expected = wav([
      chunk('LIST', Buffer.from('INFO')),
      chunk('fmt ', formatChunk({ channels, sampleRate })),
      chunk('JUNK', Buffer.from([9])),
      chunk('data', Buffer.from([0, 0, 1, 0])),
    ]);
    const { filePath } = await fixture(expected);
    assert.deepEqual(await readValidatedPiperWav(filePath), expected);
  }
});

test('requires an absolute path and a regular non-symlink file', async () => {
  const { filePath, directory } = await fixture(wav());
  await genericFailure(readValidatedPiperWav('relative.wav'), 'relative.wav');
  await genericFailure(readValidatedPiperWav(path.join(directory, 'missing.wav')));
  const linkPath = path.join(directory, 'link.wav');
  await fs.symlink(filePath, linkPath);
  await genericFailure(readValidatedPiperWav(linkPath), linkPath);
});

test('rejects malformed RIFF length, truncated chunks, empty data, and duplicate required chunks', async () => {
  const valid = wav();
  const wrongLength = Buffer.from(valid);
  wrongLength.writeUInt32LE(valid.length - 7, 4);
  const truncated = valid.subarray(0, valid.length - 1);
  const emptyData = wav([chunk('fmt ', formatChunk()), chunk('data', Buffer.alloc(0))]);
  const partialFrame = wav([chunk('fmt ', formatChunk()), chunk('data', Buffer.from([0]))]);
  const duplicateFormat = wav([chunk('fmt ', formatChunk()), chunk('fmt ', formatChunk()), chunk('data', Buffer.from([0, 0]))]);
  const duplicateData = wav([chunk('fmt ', formatChunk()), chunk('data', Buffer.from([0, 0])), chunk('data', Buffer.from([1, 0]))]);

  for (const bytes of [Buffer.alloc(0), Buffer.from('not wav'), wrongLength, truncated, emptyData, partialFrame, duplicateFormat, duplicateData]) {
    const { filePath } = await fixture(bytes);
    await genericFailure(readValidatedPiperWav(filePath), filePath);
  }
});

test('rejects unsupported encodings and incoherent or out-of-range PCM metadata', async () => {
  const invalidFormats = [
    formatChunk({ encoding: 3 }),
    formatChunk({ channels: 0 }),
    formatChunk({ channels: 3 }),
    formatChunk({ sampleRate: 7999 }),
    formatChunk({ sampleRate: 96001 }),
    formatChunk({ bits: 8 }),
    formatChunk({ byteRate: 1 }),
    formatChunk({ blockAlign: 1 }),
  ];
  for (const format of invalidFormats) {
    const { filePath } = await fixture(wav([chunk('fmt ', format), chunk('data', Buffer.from([0, 0]))]));
    await genericFailure(readValidatedPiperWav(filePath));
  }
});

test('rejects files larger than the bounded read limit', async () => {
  const { filePath } = await fixture(wav());
  const handle = await fs.open(filePath, 'r+');
  await handle.truncate(MAX_WAV_BYTES + 1);
  await handle.close();
  await genericFailure(readValidatedPiperWav(filePath), filePath);
});
