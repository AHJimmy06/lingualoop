const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { FastConformerHost, FastConformerNoSpeechError } = require('../../dist/language-practice/fastconformer-host.js');
const { FASTCONFORMER_MODEL_ID } = require('../../dist/language-practice/fastconformer-protocol.js');

const sha = 'a'.repeat(64);
const config = (overrides = {}) => ({ pythonExecutable: 'python3', workerPath: '/private/worker.py', modelPath: '/private/model.nemo', expectedSha256: sha, startupTimeoutMs: 100, ...overrides });
function harness(overrides = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.pid = 1;
  const signals = [];
  const host = new FastConformerHost(config(overrides), () => child, (_child, signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') child.emit('close', null);
  });
  return { host, child, signals };
}
const ready = () => JSON.stringify({ type: 'ready', modelId: FASTCONFORMER_MODEL_ID, modelSha256: sha }) + '\n';
async function start(host, child) {
  const starting = host.start();
  child.stdout.write(ready());
  await starting;
}
const result = (id, transcript = 'recognized words') => JSON.stringify({ type: 'result', id, transcript }) + '\n';

 test('transcribes one correlated response across stdout chunks with exact request line', async () => {
  const { host, child } = harness();
  const input = [];
  child.stdin.on('data', (chunk) => input.push(chunk));
  await start(host, child);
  const pending = host.transcribe('/audio/example.wav');
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(Buffer.concat(input).toString());
  assert.deepEqual(Object.keys(request), ['id', 'audioPath']);
  assert.match(request.id, /^[0-9a-f-]{36}$/i);
  assert.equal(Buffer.concat(input).toString(), JSON.stringify(request) + '\n');
  const line = result(request.id);
  child.stdout.write(line.slice(0, 8));
  child.stdout.write(line.slice(8));
  assert.equal(await pending, 'recognized words');
  await host.shutdown();
});

test('reserves the sole request while start is still pending and validates paths', async () => {
  const { host, child } = harness();
  const first = host.transcribe('/audio/first.wav');
  await assert.rejects(host.transcribe('/audio/second.wav'), /already in flight/);
  child.stdout.write(ready());
  const input = [];
  child.stdin.on('data', (chunk) => input.push(chunk));
  await new Promise((resolve) => setImmediate(resolve));
  const id = JSON.parse(Buffer.concat(input).toString()).id;
  child.stdout.write(result(id));
  assert.equal(await first, 'recognized words');
  await assert.rejects(host.transcribe('relative.wav'), /absolute audio path/);
  await host.shutdown();
});

test('maps legacy no-speech results to a fixed typed safe error', async () => {
  const { host, child } = harness();
  await start(host, child);
  const pending = host.transcribe('/audio/silent.wav');
  await new Promise((resolve) => setImmediate(resolve));
  const id = JSON.parse(child.stdin.read().toString()).id;
  child.stdout.write(JSON.stringify({ type: 'result', id, code: 'LANGUAGE_PRACTICE_NO_SPEECH', error: '/private details' }) + '\n');
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof FastConformerNoSpeechError);
    assert.equal(error.message, 'No speech was recognized.');
    assert.doesNotMatch(error.message, /private|silent\.wav/);
    return true;
  });
  assert.equal(child.stdin.read(), null);
  const next = host.transcribe('/audio/explicit-next.wav');
  await new Promise((resolve) => setImmediate(resolve));
  const nextRequest = JSON.parse(child.stdin.read().toString());
  assert.equal(nextRequest.audioPath, '/audio/explicit-next.wav');
  child.stdout.write(result(nextRequest.id));
  assert.equal(await next, 'recognized words');
  await host.shutdown();
});

test('mismatched, malformed, oversized, and unsolicited results fail closed', async (t) => {
  for (const scenario of ['mismatch', 'malformed', 'oversized', 'unsolicited']) {
    await t.test(scenario, async () => {
      const { host, child, signals } = harness();
      await start(host, child);
      const pending = host.transcribe('/audio/private.wav');
      await new Promise((resolve) => setImmediate(resolve));
      if (scenario === 'mismatch') child.stdout.write(result('not-the-request-id'));
      if (scenario === 'malformed') child.stdout.write('not json\n');
      if (scenario === 'oversized') child.stdout.write('x'.repeat(8193));
      if (scenario === 'unsolicited') {
        const id = JSON.parse(child.stdin.read().toString()).id;
        child.stdout.write(result(id) + result(id));
      }
      await assert.rejects(pending, (error) => {
        assert.ok(error instanceof Error);
        const { getSttDiagnostic } = require('../../dist/language-practice/fastconformer-host.js');
        const codes = { mismatch: 'request_invalid_response', malformed: 'request_invalid_response', oversized: 'request_oversized', unsolicited: 'request_unsolicited' };
        assert.deepEqual(getSttDiagnostic(error), { code: codes[scenario], component: 'fastconformer', phase: 'request' });
        assert.doesNotMatch(error.message, /private\.wav|worker\.py|model\.nemo/);
        return true;
      });
      await host.shutdown();
      assert.ok(signals.length > 0);
      await assert.rejects(host.transcribe('/audio/again.wav'), /stopped|closed/);
    });
  }
});

test('stdin errors fail closed during startup without exposing process details', async () => {
  const { host, child } = harness();
  const starting = host.start();
  const rejected = assert.rejects(starting, /Could not start FastConformer worker/);
  child.stdin.emit('error', new Error('EPIPE writing /private/audio.wav'));
  await rejected;
  assert.doesNotThrow(() => child.stdin.emit('error', new Error('EPIPE after startup failure')));
  await host.shutdown();
});

test('stdin errors fail closed without exposing process details, including after close', async () => {
  const { host, child, signals } = harness();
  await start(host, child);
  const pending = host.transcribe('/audio/private.wav');
  await new Promise((resolve) => setImmediate(resolve));
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.message, 'FastConformer worker failed');
    const { getSttDiagnostic } = require('../../dist/language-practice/fastconformer-host.js');
    assert.deepEqual(getSttDiagnostic(error), { code: 'request_stream_error', component: 'fastconformer', phase: 'request' });
    assert.doesNotMatch(error.message, /EPIPE|private\.wav|worker\.py|model\.nemo/);
    return true;
  });
  child.stdin.emit('error', new Error('EPIPE writing /private/audio.wav'));
  await rejected;
  assert.deepEqual(signals, ['SIGTERM']);
  child.emit('close', 1);
  assert.doesNotThrow(() => child.stdin.emit('error', new Error('EPIPE after close')));
  await host.shutdown();
});

test('timeout, child close, and shutdown reject pending requests and clear their lifecycle', async (t) => {
  await t.test('timeout', async () => {
    const { host, child, signals } = harness({ requestTimeoutMs: 5 });
    await start(host, child);
    await assert.rejects(host.transcribe('/audio/private.wav'), (error) => {
      const { getSttDiagnostic } = require('../../dist/language-practice/fastconformer-host.js');
      assert.deepEqual(getSttDiagnostic(error), { code: 'request_timeout', component: 'fastconformer', phase: 'request' });
      return true;
    });
    assert.deepEqual(signals, ['SIGTERM']);
    await host.shutdown();
  });
  await t.test('close', async () => {
    const { host, child } = harness();
    await start(host, child);
    const pending = host.transcribe('/audio/private.wav');
    const rejected = assert.rejects(pending, /closed/);
    child.emit('close', 1);
    await rejected;
    await host.shutdown();
  });
  await t.test('shutdown', async () => {
    const { host, child } = harness();
    await start(host, child);
    const pending = host.transcribe('/audio/private.wav');
    const rejected = assert.rejects(pending, /cancelled/);
    const stopping = host.shutdown();
    await rejected;
    await stopping;
    await assert.rejects(host.transcribe('/audio/again.wav'), /stopped|closed/);
  });
});

test('rejects invalid request timeout configuration', () => {
  for (const requestTimeoutMs of [0, -1, 90001, 1.5]) {
    assert.throws(() => new FastConformerHost(config({ requestTimeoutMs })), /Invalid FastConformer host configuration/);
  }
});
