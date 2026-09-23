const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { FastConformerHost, FASTCONFORMER_MODEL_ID } = require('../../dist/language-practice/fastconformer-host.js');

const sha = 'a'.repeat(64);
const config = (overrides = {}) => ({ pythonExecutable: 'python3', workerPath: '/private/worker.py', modelPath: '/private/model.nemo', expectedSha256: sha, startupTimeoutMs: 100, ...overrides });
function harness(overrides = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345;
  child.kill = () => true;
  const calls = [];
  const spawn = (...args) => { calls.push(args); return child; };
  const signals = [];
  const host = new FastConformerHost(config(overrides), spawn, (_child, signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') child.emit('close', null);
  });
  return { host, child, calls, signals };
}
const ready = (fields = {}) => JSON.stringify({ type: 'ready', modelId: FASTCONFORMER_MODEL_ID, modelSha256: sha, ...fields }) + '\n';
const errorIsSafe = (error) => {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /private|worker\.py|model\.nemo|exception text/i);
  return true;
};

test('spawns without a shell and resolves one fragmented exact ready line', async () => {
  const { host, child, calls } = harness();
  const starting = host.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'python3');
  assert.deepEqual(calls[0][1], ['/private/worker.py', '--model-path', '/private/model.nemo', '--model-sha256', sha]);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].detached, process.platform !== 'win32');
  child.stdout.write(ready().slice(0, 21));
  child.stdout.write(ready().slice(21));
  await starting;
  await host.shutdown();
});

test('rejects duplicate ready and arbitrary trailing startup output', async (t) => {
  for (const trailing of [ready(), 'unexpected output\n']) {
    await t.test(trailing.slice(0, 12), async () => {
      const { host, child, signals } = harness();
      const starting = host.start();
      const rejected = assert.rejects(starting, /unsolicited startup output/);
      child.stdout.write(ready() + trailing);
      await rejected;
      await host.shutdown();
      assert.deepEqual(signals, ['SIGTERM']);
    });
  }
});

test('terminates a ready worker that later writes unsolicited output', async () => {
  const { host, child, signals } = harness();
  const starting = host.start();
  child.stdout.write(ready());
  await starting;
  child.stdout.write('unexpected\n');
  await host.shutdown();
  assert.deepEqual(signals, ['SIGTERM']);
});

test('rejects malformed and mismatched ready identities without leaking config', async (t) => {
  for (const line of ['not json\n', ready({ modelId: 'wrong' }), ready({ modelSha256: 'b'.repeat(64) })]) {
    await t.test(line.slice(0, 12), async () => {
      const { host, child } = harness();
      const starting = host.start();
      const rejected = assert.rejects(starting, errorIsSafe);
      child.stdout.write(line);
      await rejected;
      await host.shutdown();
    });
  }
});

test('rejects startup timeout, child error, and premature close safely', async (t) => {
  await t.test('timeout', async () => {
    const { host } = harness({ startupTimeoutMs: 5 });
    await assert.rejects(host.start(), /timed out/);
    await host.shutdown();
  });
  await t.test('error', async () => {
    const { host, child } = harness();
    const starting = host.start();
    const rejected = assert.rejects(starting, errorIsSafe);
    child.emit('error', new Error('/private/exception text'));
    await rejected;
    await host.shutdown();
  });
  await t.test('close', async () => {
    const { host, child } = harness();
    const starting = host.start();
    const rejected = assert.rejects(starting, errorIsSafe);
    child.emit('close', 1);
    await rejected;
    await host.shutdown();
  });
});

test('caps unterminated startup output and validates bounded config', async () => {
  const { host, child } = harness();
  const starting = host.start();
  const rejected = assert.rejects(starting, /output limit/);
  child.stdout.write('x'.repeat(8193));
  await rejected;
  await host.shutdown();
  for (const override of [{ expectedSha256: 'A'.repeat(64) }, { startupTimeoutMs: 30001 }]) {
    assert.throws(() => new FastConformerHost(config(override)), /Invalid FastConformer host configuration/);
  }
});

test('shutdown rejects pending startup and sends TERM then KILL once under reentry', async () => {
  const { host, child, signals } = harness();
  const starting = host.start();
  const rejected = assert.rejects(starting, /startup cancelled/);
  const one = host.shutdown();
  const two = host.shutdown();
  assert.equal(one, two);
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(signals, ['SIGTERM']);
  child.emit('close', null);
  await one;
  assert.deepEqual(signals, ['SIGTERM']);
});

test('shutdown escalates to KILL after the bounded TERM grace', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345;
  child.kill = () => true;
  const signals = [];
  const host = new FastConformerHost(config(), () => child, (_child, signal) => signals.push(signal));
  const starting = host.start();
  const pending = host.shutdown();
  await assert.rejects(starting, /startup cancelled/);
  await pending;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(host.shutdown(), pending);
});
