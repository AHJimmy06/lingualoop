const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  FASTCONFORMER_MODEL_ID,
  FASTCONFORMER_NO_SPEECH_CODE,
  FastConformerProtocolError,
  parseReady,
  serializeRequest,
  parseResult,
} = require('../../dist/language-practice/fastconformer-protocol.js');

const sha = 'a'.repeat(64);
const protocolError = (operation, code) => {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof FastConformerProtocolError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private|secret|model|worker|exception text/i);
    return true;
  });
};

test('accepts only exact ready model identity', () => {
  assert.equal(parseReady(JSON.stringify({ type: 'ready', modelId: FASTCONFORMER_MODEL_ID, modelSha256: sha }), sha), undefined);
  protocolError(() => parseReady(JSON.stringify({ type: 'ready', modelId: 'wrong', modelSha256: sha }), sha), 'IDENTITY_MISMATCH');
  protocolError(() => parseReady(JSON.stringify({ type: 'ready', modelId: FASTCONFORMER_MODEL_ID, modelSha256: 'b'.repeat(64) }), sha), 'IDENTITY_MISMATCH');
  protocolError(() => parseReady(JSON.stringify({ type: 'ready', modelId: FASTCONFORMER_MODEL_ID, modelSha256: sha, extra: 'private' }), sha), 'UNEXPECTED_MESSAGE');
  protocolError(() => parseReady('{bad', sha), 'INVALID_LINE');
});

test('serializes bounded requests as one JSON line and requires an absolute path', () => {
  const line = serializeRequest('request-1', '/audio/input.wav');
  const request = JSON.parse(line);
  assert.deepEqual(request, { id: 'request-1', audioPath: '/audio/input.wav' });
  assert.deepEqual(Object.keys(request).sort(), ['audioPath', 'id']);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(serializeRequest('i'.repeat(256), `/${'a'.repeat(1000)}`).endsWith('\n'), true);
  for (const [id, audioPath] of [
    ['', '/a'], ['i'.repeat(257), '/a'], ['bad\nid', '/a'], ['bad\uD800', '/a'], ['id', 'relative.wav'],
    ['id', '/bad\u0000path'], ['id', `/${'a'.repeat(8192)}`],
  ]) protocolError(() => serializeRequest(id, audioPath), 'INVALID_REQUEST');
});

test('serialized request is accepted by Python worker parse_request offline', () => {
  const id = 'cross-language-request';
  const audioPath = '/audio/offline-fixture.wav';
  const workerPath = path.resolve(__dirname, '../../scripts/fastconformer-worker.py');
  const parseRequest = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("fastconformer_worker", sys.argv[1])',
    'worker = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(worker)',
    'request_id, audio_path = worker.parse_request(sys.stdin.read())',
    'print(json.dumps({"id": request_id, "audioPath": audio_path}))',
  ].join('\n');
  const parsed = execFileSync('python3', ['-c', parseRequest, workerPath], {
    input: serializeRequest(id, audioPath),
    encoding: 'utf8',
    env: { PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.deepEqual(JSON.parse(parsed), { id, audioPath });
});

test('parses exact transcript and legacy no-speech results', () => {
  const transcript = { type: 'result', id: 'request-1', transcript: 'hello there' };
  assert.deepEqual(parseResult(JSON.stringify(transcript), 'request-1'), transcript);
  const noSpeech = { type: 'result', id: 'request-1', code: FASTCONFORMER_NO_SPEECH_CODE, error: 'No speech detected' };
  assert.deepEqual(parseResult(JSON.stringify(noSpeech), 'request-1'), {
    type: 'result', id: 'request-1', code: FASTCONFORMER_NO_SPEECH_CODE, error: 'No speech was recognized.',
  });
  const hostileNoSpeech = { ...noSpeech, error: 'worker failed at /private/audio.wav' };
  const safeNoSpeech = parseResult(JSON.stringify(hostileNoSpeech), 'request-1');
  assert.equal(safeNoSpeech.error, 'No speech was recognized.');
  assert.doesNotMatch(JSON.stringify(safeNoSpeech), /worker|private|audio\.wav/);
});

test('rejects malformed, mismatched, oversized, and malicious results safely', () => {
  for (const line of ['', '{bad', '[]', 'x'.repeat(8193)]) {
    protocolError(() => parseResult(line, 'id'), line.length > 8192 ? 'LINE_TOO_LARGE' : line === '[]' ? 'INVALID_LINE' : 'INVALID_LINE');
  }
  protocolError(() => parseResult(JSON.stringify({ type: 'result', id: 'other', transcript: 'hello' }), 'id'), 'UNEXPECTED_MESSAGE');
  protocolError(() => parseResult(JSON.stringify({ type: 'result', id: 'id', transcript: '' }), 'id'), 'INVALID_RESULT');
  protocolError(() => parseResult(JSON.stringify({ type: 'result', id: 'id', transcript: '   ' }), 'id'), 'INVALID_RESULT');
  protocolError(() => parseResult(JSON.stringify({ type: 'result', id: 'id', transcript: 't'.repeat(4001) }), 'id'), 'INVALID_RESULT');
  protocolError(() => parseResult(JSON.stringify({ type: 'result', id: 'id', transcript: 'hello', audioPath: '/private/audio' }), 'id'), 'INVALID_RESULT');
  protocolError(() => parseResult(JSON.stringify({ type: 'result', id: 'id', code: 'OTHER_SECRET', error: '/private/model failure' }), 'id'), 'INVALID_RESULT');
  protocolError(() => parseResult(JSON.stringify({ type: 'result', id: 'id', code: FASTCONFORMER_NO_SPEECH_CODE, error: 'failure', transcript: 'leak' }), 'id'), 'INVALID_RESULT');
});
