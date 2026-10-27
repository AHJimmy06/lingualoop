const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { mkdtemp, readdir, readFile, rm, stat } = require('node:fs/promises');
const { writeFileSync, symlinkSync, truncateSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { withPreparedAudio } = require('../../dist/language-practice/audio-preparation.js');

function chunk(id, bytes) {
  const header = Buffer.alloc(8); header.write(id); header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, bytes.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function validWav({ list = false, channels = 1, dataBytes = 2, format = 1, malformedChunk = false } = {}) {
  const fmt = Buffer.alloc(16); fmt.writeUInt16LE(format); fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(16000, 4); fmt.writeUInt32LE(32000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const body = Buffer.concat([chunk('fmt ', fmt), ...(list ? [chunk('LIST', Buffer.from('INFO'))] : []), chunk('data', Buffer.alloc(dataBytes))]);
  if (malformedChunk) body.writeUInt32LE(100, body.length - 6);
  const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(body.length + 4, 4); header.write('WAVE', 8);
  return Buffer.concat([header, body]);
}
async function fixture({ autoClose = true, output = 'valid' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lingualoop-audio-test-'));
  const calls = [];
  let child;
  const spawnChild = (...args) => {
    calls.push(args);
    child = new EventEmitter();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.kill = (signal) => { child.signals.push(signal); return true; };
    child.signals = [];
    const outputPath = args[1].at(-1);
    if (output === 'long') writeFileSync(outputPath, validWav({ dataBytes: 60 * 32000 }));
    else if (output === 'too-long') writeFileSync(outputPath, validWav({ dataBytes: 601 * 32000 }));
    else if (output === 'valid') writeFileSync(outputPath, validWav());
    else if (output === 'list') writeFileSync(outputPath, validWav({ list: true }));
    else if (output === 'bad-chunk') writeFileSync(outputPath, validWav({ malformedChunk: true }));
    else if (output === 'wrong-channels') writeFileSync(outputPath, validWav({ channels: 2 }));
    else if (output === 'wrong-format') writeFileSync(outputPath, validWav({ format: 3 }));
    else if (output === 'malformed') writeFileSync(outputPath, 'not wav');
    else if (output === 'symlink') {
      const target = join(require('node:path').dirname(outputPath), 'target.wav');
      writeFileSync(target, validWav()); symlinkSync(target, outputPath);
    } else if (output === 'oversized') {
      writeFileSync(outputPath, validWav());
      truncateSync(outputPath, 19_200_000 + 1024 * 1024 + 1);
    }
    if (autoClose) queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  return { root, calls, spawnChild, get child() { return child; }, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}
const opts = (f, extra = {}) => ({ ffmpegExecutable: '/tools/ffmpeg', tempRoot: f.root, spawnChild: f.spawnChild, ...extra });
const waitForChild = async (f) => { while (!f.child) await new Promise((resolve) => setTimeout(resolve, 1)); };
const safeFailure = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.message, 'Audio preparation failed');
  const { getSttDiagnostic } = require('../../dist/language-practice/fastconformer-host.js');
  const detail = getSttDiagnostic(error);
  assert.equal(detail.component, 'audio_preparation');
  assert.equal(detail.phase, 'preparation');
  if (code) assert.equal(detail.code, code);
  assert.doesNotMatch(error.message, /ffmpeg|stderr|private|lingualoop-audio-test/);
  return true;
});

test('validates exact MIME and size before creating a temp directory or spawning', async () => {
  const f = await fixture();
  try {
    for (const [input, mime] of [[Buffer.alloc(0), 'audio/wav'], [Buffer.alloc(1), 'Audio/wav'],
      [Buffer.alloc(1), 'audio/webm; codecs=opus'], [Buffer.alloc(32 * 1024 * 1024 + 1), 'audio/wav']]) {
      await safeFailure(withPreparedAudio(input, mime, () => 'no', opts(f)), 'preparation_input');
    }
    assert.deepEqual(await readdir(f.root), []);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('uses fixed paths, safe permissions and FFmpeg args, then cleans after callback', async () => {
  const f = await fixture();
  try {
    const input = Buffer.from('input');
    const result = await withPreparedAudio(input, 'audio/mp4', async (wavPath) => {
      assert.equal(wavPath, require('node:path').resolve(wavPath));
      const directory = require('node:path').dirname(wavPath);
      if (process.platform !== 'win32') assert.equal((await stat(directory)).mode & 0o777, 0o700);
      if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'input.m4a'))).mode & 0o777, 0o600);
      assert.equal(await readFile(join(directory, 'input.m4a'), 'utf8'), 'input');
      return 'callback result';
    }, opts(f));
    assert.equal(result, 'callback result');
    assert.equal(f.calls.length, 1);
    const [command, args, spawnOptions] = f.calls[0];
    assert.equal(command, '/tools/ffmpeg');
    assert.equal(spawnOptions.shell, false);
    assert.deepEqual(args.slice(0, 6), ['-nostdin', '-y', '-i', args[3], '-t', '601']);
    assert.match(args[3], /[\\/]input\.m4a$/);
    assert.deepEqual(args.slice(6, 14), ['-c:a', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-f', 'wav']);
    assert.match(args[14], /[\\/]prepared\.wav$/);
    assert.deepEqual(await readdir(f.root), []);
    assert.equal(input.toString(), 'input');
  } finally { await f.cleanup(); }
});

test('keeps the unique temporary directory until callback settles and cleans after rejection', async () => {
  const f = await fixture();
  let release;
  try {
    const callbackPromise = new Promise((resolve) => { release = resolve; });
    const operation = withPreparedAudio(Buffer.from('x'), 'audio/ogg;codecs=opus', async (wavPath) => {
      const directory = require('node:path').dirname(wavPath);
      assert.match(wavPath, /[\\/]prepared\.wav$/);
      assert.deepEqual(await readdir(f.root), [require('node:path').basename(directory)]);
      await callbackPromise;
      throw new Error('/private callback details');
    }, opts(f));
    await waitForChild(f);
    assert.equal((await readdir(f.root)).length, 1);
    release();
    await safeFailure(operation);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.cleanup(); }
});

test('preserves only trusted callback diagnostics and no-speech while cleaning', async () => {
  const { SttDiagnosticError, FastConformerNoSpeechError, getSttDiagnostic } = require('../../dist/language-practice/fastconformer-host.js');
  const f = await fixture();
  try {
    for (const error of [new SttDiagnosticError('startup_malformed'), new FastConformerNoSpeechError()]) {
      await assert.rejects(withPreparedAudio(Buffer.from('x'), 'audio/wav', () => { throw error; }, opts(f)), (actual) => {
        assert.equal(actual, error);
        assert.ok(getSttDiagnostic(actual));
        return true;
      });
      assert.deepEqual(await readdir(f.root), []);
    }
    const untrusted = new Error('SECRET path credential speech');
    untrusted.code = 'startup_malformed';
    await safeFailure(withPreparedAudio(Buffer.from('x'), 'audio/wav', () => { throw untrusted; }, opts(f)));
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.cleanup(); }
});

test('accepts LIST metadata before the data chunk', async () => {
  const f = await fixture({ output: 'list' });
  try {
    assert.equal(await withPreparedAudio(Buffer.from('x'), 'audio/wav', () => 'accepted', opts(f)), 'accepted');
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.cleanup(); }
});

test('rejects missing, malformed, symlinked and oversized WAV output without calling callback', async (t) => {
  for (const output of ['missing', 'malformed', 'bad-chunk', 'wrong-channels', 'wrong-format', 'symlink', 'oversized']) {
    await t.test(output, { skip: output === 'symlink' && process.platform === 'win32' ? 'Windows symlink privilege is not assumed' : false }, async () => {
      const f = await fixture({ output });
      try {
        await safeFailure(withPreparedAudio(Buffer.from('x'), 'audio/wav', () => assert.fail('invalid WAV reached callback'), opts(f)), 'preparation_wav');
        assert.deepEqual(await readdir(f.root), []);
      } finally { await f.cleanup(); }
    });
  }
});

test('handles stderr stream errors safely and waits for child close', async () => {
  const f = await fixture({ autoClose: false });
  try {
    const promise = withPreparedAudio(Buffer.from('x'), 'audio/wav', () => assert.fail('callback must not run'), opts(f));
    await waitForChild(f);
    f.child.stderr.emit('error', new Error('/private stream failure'));
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    setTimeout(() => f.child.emit('close', null), 10);
    await safeFailure(promise);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.cleanup(); }
});

test('sanitizes spawn and nonzero-exit failures and cleans temporary files', async (t) => {
  await t.test('spawn throws', async () => {
    const f = await fixture();
    try {
      const options = opts(f, { spawnChild: () => { throw new Error('/private ffmpeg detail'); } });
      await safeFailure(withPreparedAudio(Buffer.from('x'), 'audio/wav', () => null, options), 'preparation_spawn');
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.cleanup(); }
  });
  await t.test('nonzero exit', async () => {
    const f = await fixture({ autoClose: false });
    try {
      const promise = withPreparedAudio(Buffer.from('x'), 'audio/wav', () => null, opts(f));
      await waitForChild(f);
      f.child.stderr.write('/private ffmpeg stderr');
      f.child.emit('exit', 2);
      f.child.emit('close', 2);
      await safeFailure(promise, 'preparation_process');
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.cleanup(); }
  });
});

test('timeout escalates TERM to KILL and waits for delayed close before cleanup', async () => {
  const f = await fixture({ autoClose: false });
  try {
    const promise = withPreparedAudio(Buffer.from('x'), 'audio/wav', () => assert.fail('callback must not run'), opts(f, { timeoutMs: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal((await readdir(f.root)).length, 1);
    setTimeout(() => f.child.emit('close', null), 10);
    await safeFailure(promise, 'preparation_timeout');
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.cleanup(); }
});


test('audio preparation retains a 60-second decoded response and rejects rather than truncates over 10 minutes',async()=>{
 for(const output of ['long','too-long']){const f=await fixture({output});try{
  if(output==='long') assert.equal(await withPreparedAudio(Buffer.from('audio'),'audio/webm',async file=>(await readFile(file)).length,opts(f)),60*32000+44);
  else await safeFailure(withPreparedAudio(Buffer.from('audio'),'audio/webm',()=>assert.fail('overlong audio must not be evaluated'),opts(f)),'preparation_wav');
 }finally{await f.cleanup();}}
});
