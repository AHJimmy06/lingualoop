# CPU Whisper STT (local and container)

Both environments are fixed to `base.en`, INT8, English input, four inference threads, and Silero VAD. The worker binds only to `127.0.0.1:8080`; that listener is never published as a host port. The API starts the worker and waits for model readiness before listening. First launch needs internet to populate the cache.

## Local Windows

The root `.env` is machine-specific and ignored by Git. It now points at the isolated benchmark Python 3.12 environment and the persistent model cache under `%LOCALAPPDATA%\LinguaLoop\models\huggingface`. The validated `base.en` files were copied into that cache; no NeMo changes or WSL files were made. API startup owns the Python worker; API shutdown terminates it.

Local CPU-only environment keys:

```ini
LINGUALOOP_STT_ENABLED=true
LINGUALOOP_STT_START_MODE=managed
LINGUALOOP_STT_SERVER_URL=http://127.0.0.1:8080
LINGUALOOP_STT_PORT=8080
LINGUALOOP_STT_MODEL=base.en
LINGUALOOP_STT_CPU_THREADS=4
LINGUALOOP_STT_PYTHON=C:/.../LinguaLoop/benchmarks/cpu-stt/venv/Scripts/python.exe
HF_HOME=C:/.../LinguaLoop/models/huggingface
LANGUAGE_PRACTICE_FFMPEG_PATH=C:/.../ffmpeg.exe
```

Install the isolated runtime, if needed, using `scripts/benchmark-stt-cpu.requirements.txt`. Do not install these packages into the API's Node dependencies.

## Linux Docker API image

`api/Dockerfile` installs the same pinned faster-whisper runtime and a bundled Linux ffmpeg binary, and sets `base.en`/INT8/four threads as its defaults. The Python worker runs as a private loopback child process inside the API container; the image does not expose port 8080. `/models` is a Docker volume mount point: attach a **named persistent volume** in the Portainer production stack so model and VAD downloads survive image redeploys. Configure `HF_HOME=/models/huggingface`; allow outbound HTTPS on first initialization. Do not point STT at a public URL or publish its port.

API image: `ghcr.io/ahjimmy06/lingualoop-api:latest`. The Actions workflow also tags the commit SHA. Portainer needs GHCR read access if the package is private; deploy the API and web through the existing HTTPS/reverse-proxy arrangement. Database-password/signing-key files, public origin, and the remote Piper voice setup remain separate server settings; do not copy the development `.env` to the server.

`compose.portainer-api.yml` is a Docker Standalone Portainer stack for the API. Authentication is local email/password; there is no Google OAuth configuration or OAuth env-file requirement. It joins the existing PostgreSQL network `lingualoop-postgres-net`, keeps STT on API loopback only, and stores `/models` in named volume `lingualoop-whisper-model-cache`. Start the PostgreSQL stack/network first. Add these Portainer stack environment variables: `LINGUALOOP_WEB_ORIGIN` (the exact public HTTPS origin), `LINGUALOOP_DB_PASSWORD_FILE`, and `LINGUALOOP_TOKEN_SIGNING_KEY_FILE` (the latter two are **server-side file paths**). Optionally set `LINGUALOOP_API_IMAGE` to an immutable commit-SHA tag. If GHCR packages are private, add registry read credentials to Portainer. Never put secret values in image build args.

After the API starts and migrations finish, create the very first account as admin exactly once using the API container's offline bootstrap. This command prompts for the name, email, and password without putting the password in shell history; run it from a trusted SSH session on the server:

```sh
python3 -c 'import getpass,json,sys; json.dump({"name":input("Admin name: "),"email":input("Admin email: "),"password":getpass.getpass("Admin password: ")},sys.stdout)' | docker exec -i -e LINGUALOOP_BOOTSTRAP_EXISTING_TARGET_CONFIRMED=postgres:5432/lingualoop lingualoop-api-1 node dist/auth/bootstrap-admin.js
```

The bootstrap refuses to create a second admin. Then sign in with that account; use **Admin → Accounts** to create teacher/student users manually. There is no public registration. Do not run the bootstrap against a database unless you have confirmed this is LinguaLoop's intended existing database.

`compose.baseline-web.yml` now defaults to `ghcr.io/ahjimmy06/lingualoop-web:latest`; it still proxies `/api/` to `lingualoop-api-1` and binds web only to server loopback port 5001. Route it through an HTTPS reverse proxy for secure session cookies; the hostname/proxy configuration is intentionally not guessed. The development `.env` has Windows paths and must not be copied to Linux; the Portainer stack supplies Linux-local STT/FFmpeg paths itself.

## Scope and validation

The Linux image includes Python dependencies for STT. TTS remains a separate existing Piper runtime and was not changed by this STT selection. The local benchmark report at `docs/benchmarks/cpu-speech-2026-10-21.md` is not a production guarantee: it has only one short human native-English sample. Collect consented student recordings and validate accent/noise/latency before asserting assessment-grade accuracy. Never log audio or transcripts from the runtime.
