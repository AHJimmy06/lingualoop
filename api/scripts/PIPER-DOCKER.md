# Piper in the API image

The image includes the standalone Linux C++ Piper engine at `/opt/piper/piper`
(release `2023.11.14-2`, SHA256-pinned for amd64 and arm64). Its JSONL protocol
matches `PiperHost`; the newer Python CLI is not a drop-in replacement.
The bundled shared libraries and `espeak-ng-data` stay beside the executable.
Builds fail if the artifact checksum or executable dependencies are invalid.

Voices are **not** baked into the image or downloaded at startup. Mount your
trusted model directory read-only at `/models/piper` and provide:

```text
LANGUAGE_PRACTICE_PIPER_MODEL_EN=/models/piper/en.onnx
LANGUAGE_PRACTICE_PIPER_MODEL_ES=/models/piper/es.onnx
LINGUALOOP_PIPER_MODEL_EN_SHA256=<trusted model digest>
LINGUALOOP_PIPER_SIDECAR_EN_SHA256=<trusted en.onnx.json digest>
LINGUALOOP_PIPER_MODEL_ES_SHA256=<trusted model digest>
LINGUALOOP_PIPER_SIDECAR_ES_SHA256=<trusted es.onnx.json digest>
```

`LANGUAGE_PRACTICE_PIPER_PATH=/opt/piper/piper` is already set by the image.
Do not override it with a host Windows path. Model licenses are independent of
the engine license; retain the upstream notices for your chosen voices.

## Isolated integration smoke test

With the six variables above in a dedicated `piper.env` (no application secrets):

```sh
docker build -t lingualoop-api:piper ./api
docker run --rm --network none --env-file piper.env \
  -v /absolute/path/to/piper-models:/models/piper:ro \
  lingualoop-api:piper node scripts/piper-smoke.cjs
```

On SELinux hosts, use `:ro,Z` only on a dedicated models directory. The smoke
test generates two validated WAVs per language using the real application host,
then closes only its own child processes. It starts no API and touches no DB.
This build/test does not publish images or redeploy any existing service.
