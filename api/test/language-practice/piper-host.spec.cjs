const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { PiperHost } = require('../../dist/language-practice/piper-host.js');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '../../dist/.piper-host-'));
  const modelPath = path.join(directory, 'voice.onnx');
  const model = Buffer.from('tiny synthetic model');
  const sidecar = Buffer.from('{"sample_rate":22050}');
  await fs.writeFile(modelPath, model);
  await fs.writeFile(`${modelPath}.json`, sidecar);
  return {
    voice: 'en', executable: '/synthetic/piper', modelPath,
    modelSha256: sha256(model), sidecarSha256: sha256(sidecar), startupTimeoutMs: 500,
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function harness(config, onSpawn = () => {}, onSignal = () => {}, removeDirectory) {
  let spawnCount = 0;
  const child = fakeChild();
  const host = new PiperHost(config, (executable, args, options) => {
    spawnCount++;
    onSpawn(executable, args, options, child);
    return child;
  }, (process, signal) => onSignal(process, signal), removeDirectory);
  return { host, child, get spawnCount() { return spawnCount; } };
}

function tinyWav() {
  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(2, 40); wav.writeInt16LE(0, 44);
  return wav;
}

const genericFailure = (promise) => assert.rejects(promise, (error) => {
  assert.equal(typeof error.message, 'string');
  assert.doesNotMatch(error.message, /voice\.onnx|piper-host|[a-f0-9]{64}/i);
  return true;
});

test('verifies synthetic artifacts before spawn and accepts split readiness marker', async (t) => {
  const config = await fixture(t);
  let call;
  const h = harness(config, (...args) => { call = args; });
  const started = h.host.start();
  while (!h.spawnCount) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(call[0], config.executable);
  assert.deepEqual(call[1], ['--model', config.modelPath, '--json-input']);
  assert.equal(call[2].shell, false);
  assert.deepEqual(call[2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(call[2].detached, process.platform !== 'win32');
  h.child.stderr.write('INFO: Initial');
  h.child.stderr.write('ized piper model');
  await started;
  await h.host.shutdown();
});

test('synthesis writes a unique WAV request, accepts fragmented echo, and returns validated audio', async (t) => {
  const config = await fixture(t);
  let outputDirectory;
  const h = harness(config, (_exe, _args, _opts, child) => {
    setImmediate(() => child.stderr.write('Initialized piper'));
    child.stdin.on('data', async (bytes) => {
      const request = JSON.parse(bytes.toString());
      outputDirectory = path.dirname(request.output_file);
      assert.equal(path.basename(request.output_file), 'output.wav');
      assert.notEqual(outputDirectory, config.modelPath);
      await fs.writeFile(request.output_file, tinyWav());
      child.stdout.write(Buffer.from(request.output_file.slice(0, 4)));
      child.stdout.write(Buffer.from(request.output_file.slice(4) + '\n'));
    });
  });
  const audio = await h.host.synthesize('hello');
  assert.deepEqual(audio, tinyWav());
  await assert.rejects(fs.access(outputDirectory));
  await h.host.shutdown();
});

test('cleanup failure rejects instead of returning audio', async (t) => {
  const config = await fixture(t);
  let outputPath;
  const h = harness(config, (_exe, _args, _opts, child) => {
    setImmediate(() => child.stderr.write('Initialized piper'));
    child.stdin.on('data', async (bytes) => {
      outputPath = JSON.parse(bytes.toString()).output_file;
      await fs.writeFile(outputPath, tinyWav());
      child.stdout.write(`${outputPath}\n`);
    });
  }, (child, signal) => { if (signal === 'SIGTERM') setImmediate(() => child.emit('close', 0, null)); },
  async () => { throw new Error('/private/remove-failure'); });
  await genericFailure(h.host.synthesize('cleanup failure'));
  assert.equal(path.basename(outputPath), 'output.wav');
  await assert.doesNotReject(fs.access(outputPath));
  await fs.rm(path.dirname(outputPath), { recursive: true, force: true });
  await h.host.shutdown();
});

test('busy reservation is synchronous through startup and malformed, duplicate, or unsolicited output is terminal', async (t) => {
  const config = await fixture(t);
  config.requestTimeoutMs = 20;
  const h = harness(config, (_exe, _args, _opts, child) => setImmediate(() => child.stderr.write('Initialized piper')));
  const first = h.host.synthesize('first');
  await genericFailure(h.host.synthesize('second'));
  await genericFailure(first);
  await h.host.shutdown();

  for (const response of ['mismatch', 'duplicate']) {
    const cfg = await fixture(t);
    const broken = harness(cfg, (_exe, _args, _opts, child) => {
      setImmediate(() => child.stderr.write('Initialized piper'));
      child.stdin.on('data', (bytes) => {
        const request = JSON.parse(bytes.toString());
        child.stdout.write(response === 'mismatch' ? 'wrong\n' : `${request.output_file}\n${request.output_file}\n`);
      });
    });
    await genericFailure(broken.host.synthesize('test'));
    await broken.host.shutdown();
  }
});

test('request timeout and child/stream errors reject without exposing details', async (t) => {
  const config = await fixture(t);
  config.requestTimeoutMs = 20;
  let timedOutDirectory;
  const h = harness(config, (_exe, _args, _opts, child) => {
    setImmediate(() => child.stderr.write('Initialized piper'));
    child.stdin.on('data', (bytes) => { timedOutDirectory = path.dirname(JSON.parse(bytes.toString()).output_file); });
  });
  await genericFailure(h.host.synthesize('timeout'));
  await assert.rejects(fs.access(timedOutDirectory));
  await h.host.shutdown();
  h.child.stdout.write('/stale\\n');
  await genericFailure(h.host.synthesize('stale'));
  await h.host.shutdown();

  const cfg = await fixture(t);
  const broken = harness(cfg, (_exe, _args, _opts, child) => {
    setImmediate(() => child.stderr.write('Initialized piper'));
    child.stdin.on('data', () => child.stdout.emit('error', new Error('/private/path')));
  });
  await genericFailure(broken.host.synthesize('error'));
  await broken.host.shutdown();
});

test('shutdown during startup rejects the reserved synthesis request', async (t) => {
  const config = await fixture(t);
  const h = harness(config);
  const synthesis = h.host.synthesize('cancel');
  await h.host.shutdown();
  await genericFailure(synthesis);
});

test('digest failure rejects without spawning', async (t) => {
  const config = await fixture(t);
  config.modelSha256 = '0'.repeat(64);
  const h = harness(config);
  await genericFailure(h.host.start());
  assert.equal(h.spawnCount, 0);
  await h.host.shutdown();
});

test('startup timeout terminates the fake child and rejects generically', async (t) => {
  const config = await fixture(t);
  config.startupTimeoutMs = 1000;
  const signals = [];
  const h = harness(config, (_exe, _args, _opts, child) => {
    setImmediate(() => child.emit('spawn'));
  }, (_child, signal) => signals.push(signal));
  await genericFailure(h.host.start());
  await h.host.shutdown();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('rejects unsolicited stdout and duplicate readiness markers', async (t) => {
  for (const output of ['unexpected', 'Initialized piper Initialized piper']) {
    const config = await fixture(t);
    const h = harness(config, (_exe, _args, _opts, child) => {
      setImmediate(() => child.stderr.write(output));
      if (output.startsWith('unexpected')) setImmediate(() => child.stdout.write('noise'));
    }, (_child, _signal) => {});
    await genericFailure(h.host.start());
    await h.host.shutdown();
  }
});

test('child and stream errors or premature close reject startup without leaking details', async (t) => {
  for (const failure of ['child-error', 'stdout-error', 'stderr-error', 'stdin-error', 'close']) {
    const config = await fixture(t);
    const h = harness(config, (_exe, _args, _opts, child) => {
      setImmediate(() => {
        if (failure === 'child-error') child.emit('error', new Error('/private/path'));
        else if (failure === 'close') child.emit('close', 1, null);
        else child[failure.split('-')[0]].emit('error', new Error('/private/path'));
      });
    }, (_child, _signal) => {});
    await genericFailure(h.host.start());
    await h.host.shutdown();
  }
});

test('shutdown is idempotent, awaits close, and escalates only through injected fake signaling', async (t) => {
  const config = await fixture(t);
  const signals = [];
  const h = harness(config, (_exe, _args, _opts, child) => {
    setImmediate(() => child.stderr.write('Initialized piper'));
  }, (child, signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') setImmediate(() => child.emit('close', 0, null));
  });
  await h.host.start();
  const first = h.host.shutdown();
  const second = h.host.shutdown();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.deepEqual(signals, ['SIGTERM']);
});
