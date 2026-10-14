const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { FastConformerHost, FASTCONFORMER_MODEL_ID } = require('../../dist/language-practice/fastconformer-host.js');

const sha = 'a'.repeat(64);
const config = (overrides = {}) => ({ pythonExecutable: 'python3', workerPath: '/private/worker.py', modelPath: '/private/model.nemo', expectedSha256: sha, startupTimeoutMs: 100, ...overrides });
function harness(overrides = {}, closeOnTerm = true) {
  const makeChild = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.pid = 12345;
    child.kill = () => true;
    return child;
  };
  const children = [makeChild()];
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    if (children.length === calls.length) return children[0];
    const child = makeChild();
    child.pid += children.length;
    children.push(child);
    return child;
  };
  const signals = [];
  const host = new FastConformerHost(config(overrides), spawn, (child, signal) => {
    signals.push(signal);
    if (closeOnTerm && signal === 'SIGTERM') child.emit('close', null);
  });
  return { host, get child() { return children[0]; }, children, calls, signals };
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
  assert.doesNotThrow(() => new FastConformerHost(config({ startupTimeoutMs: 60000 })));
  for (const override of [{ expectedSha256: 'A'.repeat(64) }, ...[60001, 0, -1, 1.5, NaN, Infinity].map((startupTimeoutMs) => ({ startupTimeoutMs }))]) {
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

test('does not recover after an idle child error', async () => {
  const { host, children, calls } = harness();
  const starting = host.start();
  children[0].stdout.write(ready());
  await starting;
  children[0].emit('error', new Error('process failure'));
  await host.shutdown();
  await assert.rejects(host.transcribe('/audio/new.wav'), /stopped or closed/);
  assert.equal(calls.length, 1);
});

test('does not spend recovery budget on invalid audio paths after a ready-worker close', async () => {
  const { host, children, calls } = harness();
  const starting = host.start();
  children[0].stdout.write(ready());
  await starting;
  children[0].emit('close', 1);
  await assert.rejects(host.transcribe('relative.wav'), /absolute audio path/);
  const next = host.transcribe('/audio/valid.wav');
  assert.equal(calls.length, 2);
  children[1].stdout.write(ready());
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(children[1].stdin.read().toString());
  children[1].stdout.write(JSON.stringify({ type: 'result', id: request.id, transcript: 'recovered' }) + '\n');
  assert.equal(await next, 'recovered');
  await host.shutdown();
});

test('stdout and stderr errors fail closed during startup, requests, and idle state', async (t) => {
  for (const streamName of ['stdout', 'stderr']) {
    await t.test(`${streamName} startup error`, async () => {
      const { host, child } = harness();
      const starting = assert.rejects(host.start(), /Could not start FastConformer worker/);
      child[streamName].emit('error', new Error('private stream detail'));
      await starting;
      await host.shutdown();
    });
    await t.test(`${streamName} request error`, async () => {
      const { host, child, calls } = harness();
      const starting = host.start();
      child.stdout.write(ready());
      await starting;
      const request = host.transcribe('/audio/request.wav');
      const rejected = assert.rejects(request, /FastConformer worker failed/);
      child[streamName].emit('error', new Error('private stream detail'));
      await rejected;
      await host.shutdown();
      await assert.rejects(host.transcribe('/audio/later.wav'), /stopped or closed/);
      assert.equal(calls.length, 1);
    });
  }
  await t.test('idle stream error shuts down without recovery', async () => {
    const { host, child, calls } = harness();
    const starting = host.start();
    child.stdout.write(ready());
    await starting;
    child.stderr.emit('error', new Error('private stream detail'));
    await host.shutdown();
    await assert.rejects(host.transcribe('/audio/later.wav'), /stopped or closed/);
    assert.equal(calls.length, 1);
  });
});

test('recovers once after ready-worker close on a later request without replaying death', async () => {
  const { host, children, calls } = harness();
  const starting = host.start();
  children[0].stdout.write(ready());
  await starting;
  const first = host.transcribe('/audio/first.wav');
  const firstRejected = assert.rejects(first, /worker closed/);
  children[0].emit('close', 1);
  await firstRejected;

  const second = host.transcribe('/audio/second.wav');
  assert.equal(calls.length, 2);
  children[1].stdout.write(ready());
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(children[1].stdin.read().toString());
  assert.notEqual(request.id, undefined);
  children[1].stdout.write(JSON.stringify({ type: 'result', id: request.id, transcript: 'recovered' }) + '\n');
  assert.equal(await second, 'recovered');
  await host.shutdown();
});

test('consumes the only recovery attempt even when replacement startup fails', async () => {
  const { host, children, calls } = harness();
  const starting = host.start();
  children[0].stdout.write(ready());
  await starting;
  children[0].emit('close', 1);
  const replacement = host.transcribe('/audio/new.wav');
  children[1].emit('close', 1);
  await assert.rejects(replacement, /closed during startup/);
  await assert.rejects(host.transcribe('/audio/third.wav'), /stopped or closed/);
  assert.equal(calls.length, 2);
  await host.shutdown();
});

test('does not recover after explicit shutdown and makes concurrent recovery requests single-flight', async () => {
  const { host, children, calls } = harness();
  const starting = host.start();
  children[0].stdout.write(ready());
  await starting;
  children[0].emit('close', 1);
  const replacement = host.transcribe('/audio/new.wav');
  await assert.rejects(host.transcribe('/audio/overlap.wav'), /already in flight/);
  await host.shutdown();
  await assert.rejects(replacement, /cancelled/);
  assert.equal(calls.length, 2);
  await assert.rejects(host.transcribe('/audio/after-stop.wav'), /stopped or closed/);
});

test('ignores stale previous-child events after replacement becomes current', async () => {
  const { host, children, calls } = harness();
  const starting = host.start();
  children[0].stdout.write(ready());
  await starting;
  children[0].emit('close', 1);
  const replacement = host.transcribe('/audio/new.wav');
  children[1].stdout.write(ready());
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stdout.write('stale output\n');
  children[0].stdout.emit('error', new Error('stale stdout'));
  children[0].stderr.emit('error', new Error('stale stderr'));
  children[0].emit('error', new Error('stale'));
  children[0].emit('close', 1);
  const request = JSON.parse(children[1].stdin.read().toString());
  children[1].stdout.write(JSON.stringify({ type: 'result', id: request.id, transcript: 'still alive' }) + '\n');
  assert.equal(await replacement, 'still alive');
  assert.equal(calls.length, 2);
  await host.shutdown();
});

test('transcribe preserves finite startup diagnostics instead of cancellation', async (t) => {
  const cases = [
    ['startup_malformed', (child) => child.stdout.write('SECRET not json\n')],
    ['startup_identity', (child) => child.stdout.write(ready({ modelId: 'SECRET' }))],
    ['startup_output_limit', (child) => child.stdout.write('x'.repeat(8193))],
    ['startup_unsolicited', (child) => child.stdout.write(ready() + 'SECRET\n')],
    ['startup_process_error', (child) => child.emit('error', new Error('SECRET /private'))],
    ['startup_stream_error', (child) => child.stderr.emit('error', new Error('SECRET'))],
    ['startup_closed', (child) => child.emit('close', 2)],
    ['startup_timeout', () => {}],
  ];
  for (const [code, trigger] of cases) await t.test(code, async () => {
    const { host, child, children, calls } = harness({ startupTimeoutMs: 10 });
    const rejected = assert.rejects(host.transcribe('/private/SECRET.wav'), (error) => {
      const { getSttDiagnostic } = require('../../dist/language-practice/fastconformer-host.js');
      assert.deepEqual(getSttDiagnostic(error), { code, component: 'fastconformer', phase: 'startup' });
      assert.doesNotMatch(error.message, /SECRET|private/);
      return true;
    });
    trigger(child);
    await rejected;
    assert.equal(calls.length, 1);
    const next = host.transcribe('/audio/explicit-next.wav');
    assert.equal(calls.length, 2);
    await finishRequest(children[1], next, '/audio/explicit-next.wav');
    await host.shutdown();
  });
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function finishRequest(child, pending, audioPath) {
  child.stdout.write(ready());
  await flush();
  const request = JSON.parse(child.stdin.read().toString());
  assert.equal(request.audioPath, audioPath);
  child.stdout.write(JSON.stringify({ type: 'result', id: request.id, transcript: 'recovered' }) + '\n');
  assert.equal(await pending, 'recovered');
}

test('60-second startup allows readiness after the old ceiling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, child, calls } = harness({ startupTimeoutMs: 60000 });
  const pending = host.transcribe('/audio/late.wav');
  t.mock.timers.tick(30001);
  await finishRequest(child, pending, '/audio/late.wav');
  assert.equal(calls.length, 1);
  await host.shutdown();
});

test('startup timeout rejects once at 60000 and recovers only on a later valid request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, child, children, calls } = harness({ startupTimeoutMs: 60000 });
  let rejections = 0;
  const pending = host.transcribe('/audio/failed.wav');
  pending.catch(() => { rejections++; });
  const rejected = assert.rejects(pending, (error) => {
    const { getSttDiagnostic } = require('../../dist/language-practice/fastconformer-host.js');
    assert.equal(getSttDiagnostic(error).code, 'startup_timeout');
    return errorIsSafe(error);
  });
  t.mock.timers.tick(59999);
  await flush();
  assert.equal(rejections, 0);
  t.mock.timers.tick(1);
  await rejected;
  await flush();
  assert.equal(rejections, 1);
  assert.equal(calls.length, 1);
  assert.equal(child.stdin.read(), null);
  await assert.rejects(host.transcribe('relative.wav'), /absolute audio path/);
  assert.equal(calls.length, 1);
  const replacement = host.transcribe('/audio/new.wav');
  await assert.rejects(host.transcribe('/audio/concurrent.wav'), /already in flight/);
  assert.equal(calls.length, 2);
  child.stdout.write(ready());
  child.stdin.emit('error', new Error('stale input'));
  child.stderr.emit('error', new Error('stale stderr'));
  child.emit('error', new Error('stale process'));
  child.emit('close', 1);
  await finishRequest(children[1], replacement, '/audio/new.wav');
  assert.equal(rejections, 1);
  children[1].emit('close', 1);
  await assert.rejects(host.transcribe('/audio/budget-spent.wav'), /stopped or closed/);
  assert.equal(calls.length, 2);
  await host.shutdown();
});

test('cleanup grace expiration is not exit confirmation; later close permits one replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, child, children, calls, signals } = harness({}, false);
  const rejected = assert.rejects(host.transcribe('/audio/failed.wav'), /malformed startup/);
  child.stdout.write('not json\n');
  await rejected;
  await assert.rejects(host.transcribe('/audio/before-close.wav'), /stopped or closed/);
  t.mock.timers.tick(1500);
  await flush();
  t.mock.timers.tick(250);
  await flush();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(host.transcribe('/audio/after-grace.wav'), /stopped or closed/);
  assert.equal(calls.length, 1);
  child.emit('close', 1);
  const next = host.transcribe('/audio/confirmed.wav');
  assert.equal(calls.length, 2);
  await finishRequest(children[1], next, '/audio/confirmed.wav');
  const stopping = host.shutdown();
  children[1].emit('close', 0);
  await stopping;
});

test('confirmed close permits recovery while old cleanup is still settling', async () => {
  const { host, child, children, calls, signals } = harness({}, false);
  const rejected = assert.rejects(host.transcribe('/audio/failed.wav'), /malformed startup/);
  child.stdout.write('not json\n');
  await rejected;
  child.emit('close', 1);
  const next = host.transcribe('/audio/next.wav');
  assert.equal(calls.length, 2);
  child.emit('close', 1);
  await finishRequest(children[1], next, '/audio/next.wav');
  assert.deepEqual(signals, ['SIGTERM']);
  const stopping = host.shutdown();
  children[1].emit('close', 0);
  await stopping;
});

test('confirmed startup close recovers once, even if replacement startup also fails', async () => {
  const { host, child, children, calls } = harness();
  const first = assert.rejects(host.transcribe('/audio/first.wav'), /closed during startup/);
  child.emit('close', 1);
  await first;
  const next = assert.rejects(host.transcribe('/audio/next.wav'), /malformed startup/);
  assert.equal(calls.length, 2);
  children[1].stdout.write('not json\n');
  await next;
  await assert.rejects(host.transcribe('/audio/third.wav'), /stopped or closed/);
  assert.equal(calls.length, 2);
  await host.shutdown();
});

test('explicit shutdown permanently disables failed-startup recovery and first use', async () => {
  for (const failedStartup of [false, true]) {
    const { host, child, calls } = harness();
    if (failedStartup) {
      const rejected = assert.rejects(host.transcribe('/audio/first.wav'), /malformed startup/);
      child.stdout.write('not json\n');
      await rejected;
    }
    await host.shutdown();
    await assert.rejects(host.start(), /stopped or closed/);
    await assert.rejects(host.transcribe('/audio/later.wav'), /stopped or closed/);
    assert.equal(calls.length, failedStartup ? 1 : 0);
  }
});

test('request deadline still includes startup and never replays a timed-out request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, child, calls } = harness({ startupTimeoutMs: 60000 });
  const rejected = assert.rejects(host.transcribe('/audio/deadline.wav'), /transcription timed out/);
  t.mock.timers.tick(59999);
  child.stdout.write(ready());
  await flush();
  assert.equal(JSON.parse(child.stdin.read().toString()).audioPath, '/audio/deadline.wav');
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(host.pendingRequest !== undefined, true);
  t.mock.timers.tick(1);
  await rejected;
  await assert.rejects(host.transcribe('/audio/after-timeout.wav'), /stopped or closed/);
  assert.equal(calls.length, 1);
  assert.equal(child.stdin.read(), null);
  await host.shutdown();
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
