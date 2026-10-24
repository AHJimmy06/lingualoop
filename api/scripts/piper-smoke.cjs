// Run inside the built API image with the real voice files mounted read-only.
// No DB, API server, network access, or model downloads are needed.
const assert = require('node:assert/strict');
const { PiperRuntimeHost, loadPiperRuntimeConfiguration } = require('../dist/language-practice/piper-runtime.providers.js');

async function main() {
  const configuration = loadPiperRuntimeConfiguration();
  assert.ok(configuration, 'Provide both model paths and all four trusted SHA256 values');
  const runtime = new PiperRuntimeHost(configuration);
  try {
    for (const [voice, text] of [['en', 'Hello, welcome to LinguaLoop.'], ['es', 'Hola, bienvenido a LinguaLoop.']]) {
      // Two requests verify that each process stays alive and speaks JSONL.
      for (let turn = 1; turn <= 2; turn++) {
        const wav = await runtime.getHost(voice).synthesize(text);
        assert.ok(wav.length > 44);
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
        assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
        console.log(`Piper ${voice} turn ${turn}: OK (${wav.length} WAV bytes)`);
      }
    }
  } finally {
    await runtime.onApplicationShutdown();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
