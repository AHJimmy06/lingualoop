const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_PIPER_REQUEST_BYTES,
  MAX_PIPER_RESPONSE_BYTES,
  PiperProtocolError,
  serializePiperRequest,
  parsePiperResponse,
} = require('../../dist/language-practice/piper-protocol.js');

const outputPath = '/tmp/piper-output.wav';

function rejectsSafely(operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof PiperProtocolError);
    assert.equal(error.message, 'Invalid Piper protocol data');
    assert.doesNotMatch(error.message, /tmp|piper-output|secret/i);
    return true;
  });
}

test('serializes the legacy Piper JSON-line shape with Unicode intact', () => {
  const line = serializePiperRequest('Hola, 世界 👋', outputPath);
  assert.equal(line.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(line), { text: 'Hola, 世界 👋', output_file: outputPath });
  assert.deepEqual(Object.keys(JSON.parse(line)), ['text', 'output_file']);
  assert.equal(Buffer.byteLength(line.slice(0, -1), 'utf8') <= MAX_PIPER_REQUEST_BYTES, true);
});

test('bounds request UTF-8 and serialized JSON sizes', () => {
  assert.equal(serializePiperRequest('é'.repeat(100), outputPath).endsWith('\n'), true);
  rejectsSafely(() => serializePiperRequest('é'.repeat(MAX_PIPER_REQUEST_BYTES / 2 + 1), outputPath));
  // Escaping doubles each backslash, so the JSON limit applies independently of input UTF-8 size.
  rejectsSafely(() => serializePiperRequest('\\'.repeat(9_000), outputPath));
  rejectsSafely(() => serializePiperRequest('x'.repeat(MAX_PIPER_REQUEST_BYTES), outputPath));
});

test('rejects blank text, control characters, and malformed Unicode', () => {
  for (const text of ['', ' \t ', 'line\nbreak', 'carriage\rreturn', 'nul\0byte', 'control\u0085', '\ud800', '\udc00']) {
    rejectsSafely(() => serializePiperRequest(text, outputPath));
  }
  assert.equal(serializePiperRequest('valid 😀 text', outputPath).endsWith('\n'), true);
});

test('requires a bounded absolute control-free output path', () => {
  for (const path of ['relative.wav', '', '/bad\npath', '/bad\0path', '/bad\u007fpath', '/\ud800', `/${'x'.repeat(4096)}`]) {
    rejectsSafely(() => serializePiperRequest('speech', path));
  }
  assert.deepEqual(JSON.parse(serializePiperRequest('speech', `/${'x'.repeat(4_095)}`)), {
    text: 'speech', output_file: `/${'x'.repeat(4_095)}`,
  });
});

test('accepts only the exact echoed path, with optional CRLF terminator', () => {
  assert.equal(parsePiperResponse(outputPath, outputPath), undefined);
  assert.equal(parsePiperResponse(`${outputPath}\r`, outputPath), undefined);
  for (const line of [` ${outputPath}`, `${outputPath} `, `/tmp/other.wav`, `${outputPath}\n`, `${outputPath}\r\r`, `${outputPath}\0`]) {
    rejectsSafely(() => parsePiperResponse(line, outputPath));
  }
});

test('rejects oversized responses and invalid expected paths without echoing paths', () => {
  rejectsSafely(() => parsePiperResponse('secret'.repeat(MAX_PIPER_RESPONSE_BYTES), outputPath));
  rejectsSafely(() => parsePiperResponse(outputPath, 'relative-secret-path'));
  rejectsSafely(() => parsePiperResponse(outputPath, `/private/${'x'.repeat(4_100)}`));
});
