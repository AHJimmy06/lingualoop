const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyPiperArtifact } = require('../../dist/language-practice/piper-artifacts.js');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(__dirname, '../../dist/.piper-artifact-'));
  const modelPath = path.join(directory, 'voice.onnx');
  const targetPath = options.symlinkModel ? path.join(directory, 'target.onnx') : modelPath;
  const modelBytes = options.emptyModel ? Buffer.alloc(0) : Buffer.from('offline Piper model');
  const sidecarBytes = options.emptySidecar ? Buffer.alloc(0) : Buffer.from('{"sample_rate":22050}');
  await fs.writeFile(targetPath, modelBytes);
  if (options.symlinkModel) await fs.symlink(targetPath, modelPath);
  if (!options.missingSidecar) await fs.writeFile(`${modelPath}.json`, sidecarBytes);
  return {
    modelPath,
    modelBytes,
    sidecarBytes,
    modelSha256: sha256(modelBytes),
    sidecarSha256: sha256(sidecarBytes),
  };
}

const verify = (voice, artifacts, overrides = {}) => verifyPiperArtifact(
  voice,
  artifacts.modelPath,
  overrides.modelSha256 ?? artifacts.modelSha256,
  overrides.sidecarSha256 ?? artifacts.sidecarSha256,
);

const genericFailure = (promise) => assert.rejects(promise, (error) => {
  assert.equal(error.message, 'Invalid Piper artifact');
  assert.doesNotMatch(error.message, /[a-f0-9]{64}|piper-artifact|voice\.onnx/i);
  return true;
});

test('accepts valid injected English and Spanish artifacts offline', async (t) => {
  for (const voice of ['en', 'es']) {
    await t.test(voice, async (t) => {
      const artifacts = await fixture(t);
      await verify(voice, artifacts);
    });
  }
});

test('rejects a model or sidecar digest mismatch', async (t) => {
  const artifacts = await fixture(t);
  await genericFailure(verify('en', artifacts, { modelSha256: 'a'.repeat(64) }));
  await genericFailure(verify('es', artifacts, { sidecarSha256: 'b'.repeat(64) }));
});

test('requires the sidecar and valid object JSON', async (t) => {
  const missing = await fixture(t, { missingSidecar: true });
  await genericFailure(verify('en', missing));

  const malformed = await fixture(t);
  const bytes = Buffer.from('{broken');
  await fs.writeFile(`${malformed.modelPath}.json`, bytes);
  await genericFailure(verify('es', malformed, { sidecarSha256: sha256(bytes) }));
});

test('rejects symlinks and invalid model paths', async (t) => {
  const symlinked = await fixture(t, { symlinkModel: true });
  await genericFailure(verify('en', symlinked));

  await genericFailure(verifyPiperArtifact('en', 'relative.onnx', symlinked.modelSha256, symlinked.sidecarSha256));
  await genericFailure(verifyPiperArtifact('en', `${path.dirname(symlinked.modelPath)}/../voice.onnx`, symlinked.modelSha256, symlinked.sidecarSha256));
  await genericFailure(verifyPiperArtifact('en', symlinked.modelPath.replace(/\.onnx$/, '.bin'), symlinked.modelSha256, symlinked.sidecarSha256));
});

test('rejects empty model and sidecar files', async (t) => {
  const emptyModel = await fixture(t, { emptyModel: true });
  await genericFailure(verify('en', emptyModel));

  const emptySidecar = await fixture(t, { emptySidecar: true });
  await genericFailure(verify('es', emptySidecar));
});

test('enforces the model and sidecar size limits before reading them', async (t) => {
  const largeModel = await fixture(t);
  const modelHandle = await fs.open(largeModel.modelPath, 'r+');
  await modelHandle.truncate(1024 * 1024 * 1024 + 1);
  await modelHandle.close();
  await genericFailure(verify('en', largeModel));

  const largeSidecar = await fixture(t);
  const sidecar = Buffer.alloc(128 * 1024 + 1, 32);
  await fs.writeFile(`${largeSidecar.modelPath}.json`, sidecar);
  await genericFailure(verify('es', largeSidecar, { sidecarSha256: sha256(sidecar) }));
});

test('rejects unsupported voices and malformed expected digests', async (t) => {
  const artifacts = await fixture(t);
  await genericFailure(verifyPiperArtifact('high', artifacts.modelPath, artifacts.modelSha256, artifacts.sidecarSha256));
  await genericFailure(verifyPiperArtifact('en', artifacts.modelPath, artifacts.modelSha256.toUpperCase(), artifacts.sidecarSha256));
});
