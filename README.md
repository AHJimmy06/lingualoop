# LinguaLoop

LinguaLoop is an actively developed language-practice application with a React/Vite frontend and NestJS API. It supports manually provisioned email/password accounts and optional Google and Microsoft sign-in, protected speech endpoints, and local STT/TTS runtimes. OAuth requires provider credentials and exact callback/origin configuration; the OpenAI coach remains opt-in and is called only for an explicit practice-turn request. Review the deployment prerequisites below before treating a new server install as ready for users.

## Development

Use a current Node.js version compatible with the source project (`^20.19.0 || >=22.12.0`) and pnpm.

### Windows local development (database in Docker)

The supported local workflow keeps **only PostgreSQL in Docker**. It uses a fresh, isolated `lingualoop-local-dev-postgres-data` volume and publishes the database on `127.0.0.1:5544`; it does not reuse or alter the historical Compose database/volume. Copy `.env.example` to the ignored root `.env`, set the local password-file path, signing key and FFmpeg path, then run these commands from the repository root in separate terminals:

```powershell
docker compose --env-file .env -p lingualoop-local-dev -f compose.local-db.yml up -d postgres
cd api; pnpm install; pnpm build; pnpm migrate; pnpm dev
cd web; pnpm install; pnpm dev
```

The API's `dev`, `start`, and `migrate` scripts load `../.env` explicitly. Vite serves `http://localhost:5001` and proxies `/api` to the local API on port `5000`. Stop PostgreSQL with `docker compose --env-file .env -p lingualoop-local-dev -f compose.local-db.yml stop`; keep its named volume to preserve local data.

The native Windows install uses NVIDIA NeMo-Speech.cpp with the multilingual `nemotron-3.5` model and Piper voices for English and Spanish. Install/download models once; thereafter, starting the API starts both local speech runtimes, and shutting it down stops the runtimes it owns. STT binds only to loopback and transcription runs only when an authenticated audio endpoint is called; Piper voices load at API start, while synthesis runs only on a TTS request:

```powershell
.\scripts\Install-SttModel.ps1
.\scripts\Start-Stt.ps1
.\scripts\Stop-Stt.ps1
```

The API validates STT as loopback-only and uses FFmpeg locally to normalize browser audio to WAV. The NeMo model, Piper voices and runtimes are stored under the user's local app-data folders, not in Git. `Start-Stt.ps1` and `Stop-Stt.ps1` remain available for standalone STT operation when the API is not running.

The OpenAI coach is **disabled by default** (`LINGUALOOP_OPENAI_COACH_ENABLED=false`). Enabling it only makes the coach available; the API client/key are initialized lazily and a request is sent only when a user submits a practice turn. API usage is billed separately from ChatGPT.

Do not combine `compose.local-db.yml` with the historical app stack when using this flow. The `compose.roles-*.yml` files remain a separate integration environment.

```sh
cd api && pnpm install && LINGUALOOP_DB_PASSWORD_FILE=/absolute/path/to/password LINGUALOOP_TOKEN_SIGNING_KEY_FILE=/absolute/path/to/token-signing-key PORT=5000 pnpm dev
cd web && pnpm install && pnpm dev
```

The API exposes `GET /health` as process liveness and `GET /ready` as a PostgreSQL readiness probe (`SELECT 1`); when run locally, set `PORT=5000` to match the browser-facing localhost setup (the API's standalone default remains `3400`). The Nest runtime requires `LINGUALOOP_DB_PASSWORD_FILE` to point to the existing password file. The Vite dev server binds to `localhost:5001` and proxies `/api` to `http://localhost:5000`, removing the `/api` prefix (`http://localhost:5001/api/health` reaches `/health`).

An API container image can be built with `docker build -t lingualoop-api ./api`. The Compose API service builds from that same `api/` context, listens on container port `5000`, and publishes it only on host loopback port `5000`. Its healthcheck makes an HTTP GET to `/health` using Node's built-in `fetch`, so database outages do not affect liveness. `/ready` executes `SELECT 1` and fails with HTTP 503 when PostgreSQL is unavailable. The API shares PostgreSQL's private Compose network and mounts the existing `pg_password` secret at `/run/secrets/pg_password`; only that file path is configured in the environment, never the password value. PostgreSQL has no published host port. The historical Compose API publish remains bound to IPv4 loopback `127.0.0.1:5000`; the browser-facing local app uses `localhost`.

Each app is an independent pnpm project with its own `pnpm-lock.yaml`. Build checks do not establish any Language Practice functionality or deployment readiness.

`web/src/features/language-practice/PracticeRecorder.vue` is a standalone, parent-controlled audio recorder component. It requests microphone access only after an explicit Start action, emits one valid audio `Blob` to its parent, and performs no network or paid inference calls. The parent can disable it while a turn is pending; the component enforces a 20-second maximum, 2 MiB payload cap, and 250 ms minimum. The live session view now connects the recorder to turn submission, same-turn checks, and bounded WAV response playback, alongside setup, owned session detail, timer projection, and completion/report routing. Browser audio behavior and real inference remain unaccepted; no paid inference call was made for this change. No transcription or text-to-speech form is added.

## Authentication

LinguaLoop supports manually provisioned email/password accounts and optional Google and Microsoft sign-in. There is no public signup: an external identity can only link to an existing account with the matching email. Passwords are stored as salted scrypt hashes, and all sign-in methods issue the same short-lived LinguaLoop JWT plus an HttpOnly refresh cookie.

Google and Microsoft buttons appear on `/login` only when that provider's client ID, client secret, and exact API callback URL are configured. Google requires a verified email; Microsoft uses the `/common` authority, allowing both personal Microsoft accounts and work/school accounts. Register `http(s)://<api-host>/auth/google/callback` and `http(s)://<api-host>/auth/microsoft/callback` in the provider apps. The API validates issuer, audience, expiry, nonce (Microsoft), and one-use state; provider tokens are never placed in browser URLs. First sign-in links a provider identity to an already-created LinguaLoop account by normalized email; it does not create a user or grant a role.

`LINGUALOOP_WEB_ORIGIN` is the exact browser-facing origin (scheme + hostname + optional port, no path). It is checked on login/refresh/logout to reject cross-origin browser requests and set the appropriate session-cookie security attributes. Local development uses `http://localhost:5001`; public deployment must use the exact HTTPS URL opened by users, normally behind the HTTPS reverse proxy. Docker's private network address is not the address seen by the browser, so the containers cannot infer this value.

The API also needs `LINGUALOOP_TOKEN_SIGNING_KEY` or `LINGUALOOP_TOKEN_SIGNING_KEY_FILE` (exactly one). This is an independent secret used by the backend to sign and verify session JWTs; it is not a frontend setting or the PostgreSQL password. Keep it stable across restarts and deployments. Rotating it invalidates existing access tokens. In Portainer the stack variable is only a **path** to a protected server-side key file, not the key value.

`LINGUALOOP_DB_PASSWORD_FILE` is likewise a path to the dedicated PostgreSQL password file. Its contents must match the password configured for the LinguaLoop database. It is separate from each person's LinguaLoop login password. The Portainer API stack mounts the DB password and signing key as Docker secrets; the paths are configured once for that stack, not copied into the web container.

Create the first admin only on an empty LinguaLoop account table using the offline CLI in `api/src/auth/bootstrap-admin.ts`; it never creates accounts automatically during API startup. The admin can create teacher/student accounts through **Admin → Accounts**. The bootstrap requires an explicit target confirmation and never overwrites an existing user or password.

### Optional protected speech transcription

Two private files were provisioned outside the repository with mode `0600`: `~/.local/share/lingualoop/coach.env` contains only `OPENAI_API_KEY`; `~/.local/share/lingualoop/practice-models.env` contains only `LANGUAGE_PRACTICE_OPENAI_MODEL`, `LANGUAGE_PRACTICE_FASTCONFORMER_MODEL_PATH`, `LANGUAGE_PRACTICE_FASTCONFORMER_MODEL_SHA256`, `LANGUAGE_PRACTICE_PIPER_PATH`, `LANGUAGE_PRACTICE_PIPER_MODEL_EN`, `LANGUAGE_PRACTICE_PIPER_MODEL_ES`, `LANGUAGE_PRACTICE_FFMPEG_PATH`, `LINGUALOOP_PIPER_MODEL_EN_SHA256`, `LINGUALOOP_PIPER_SIDECAR_EN_SHA256`, `LINGUALOOP_PIPER_MODEL_ES_SHA256`, and `LINGUALOOP_PIPER_SIDECAR_ES_SHA256`. Do not reuse NousAI's whole `.env`, JWT/signing key, database, or data. No paid inference calls are authorized; obtain fresh explicit authorization before any paid call.

When a valid authenticated local account/session and the exact FastConformer/FFmpeg runtime settings are valid, the API additionally mounts `POST /practice/transcribe`. It requires the verified Google bearer session and accepts only raw `audio/webm`, `audio/webm;codecs=opus`, `audio/ogg`, `audio/ogg;codecs=opus`, `audio/wav`, `audio/x-wav`, or `audio/mp4` bodies up to 2 MiB. The route permits one active preparation/transcription per API process, prepares a private temporary WAV, and returns only `{ "transcript": "..." }` with no-store headers after success. Authentication, size, media-type, preparation, and inference failures remain generic. The feature does not accept multipart, trust caller-provided owner/session IDs or cookies, persist audio/transcripts, invoke coaching/Piper, or make paid calls. Health-only or incomplete configuration does not expose the route. Automated HTTP tests use fake preparation/transcription providers; they do not establish a real FFmpeg/model inference or runtime acceptance.

### Optional protected Piper synthesis

When a valid authenticated local account/session and the Piper executable, both `.onnx` model paths, and all four model/sidecar SHA-256 settings are valid, the API independently mounts `POST /practice/synthesize`; FastConformer/FFmpeg settings are not required. It requires the verified owner/session bearer and exactly `{ "language": "en"|"es", "text": "..." }`, with a 500-character limit and no control characters or extra fields. Only one synthesis runs per API process at a time. Success returns the Piper host's artifact-validated WAV bytes as `audio/wav`; errors are generic and responses are not cached. Piper processes and model verification start lazily on the first request, not during API startup. No audio/text is persisted and this route does not invoke coaching or paid services. Automated HTTP tests use fake hosts; real model and browser playback acceptance remain pending.

The configured hashes pin the local files observed at provisioning time; they do not establish publisher provenance. The optional practice runtime overlay below loads only the path and model settings from these files and mounts the listed host artifacts read-only. Keep these external files intact when rolling back by omitting the overlay.

### Protected practice routes and AI reports

Local password authentication enables owner-scoped `POST /language-practice/sessions`; the audio-turn route additionally needs configured local STT, Piper, and a valid guarded OpenAI coach. Recording admission remains bounded and replay-safe. The coach and report adapter share the explicit private key-file and allowlisted `LANGUAGE_PRACTICE_OPENAI_MODEL` (`gpt-5.6-luna` or `gpt-6-luna`), using an SDK client with zero retries and a 90-second timeout; invalid settings disable turn inference and make new evidence-bearing report generation unavailable without disabling session access. The protected `POST /language-practice/sessions/:sessionId/report` endpoint returns historical reports unchanged, drafts a new AI report from completed turns with a bounded per-session claim, and saves it once with truthful provenance. Without completed turns, it saves a non-AI no-evidence report. Errors are generic and responses use `Cache-Control: private, no-store`. The LinguaLoop API was locally recreated after migrations 009–010; actual authenticated AI generation remains unverified and can incur a provider charge when a user requests a new report.

`compose.coach.yml` is an optional, API-only overlay. It mounts the external `coach.env` as a read-only Compose secret and passes only the nonsecret model identifier in the environment. It does not load `coach.env` through `env_file`, nor does it configure or change browser or NousAI environments. Validate the overlay with path-only settings and quiet output (do not use `docker compose config` without `--quiet`, because resolved configuration may expose secret values):

```sh
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" \
LINGUALOOP_OPENAI_API_KEY_FILE="$HOME/.local/share/lingualoop/coach.env" \
LANGUAGE_PRACTICE_OPENAI_MODEL=gpt-5.6-luna \
docker compose -p lingualoop -f compose.postgres.yml -f compose.coach.yml config --quiet
```

To roll back this configuration, omit `compose.coach.yml` from the Compose file list; retain the external key file. Do not start a provider or practice turn as part of this configuration-only step.

## Optional local voice runtime mounts (not connected)

The API image includes only the LinguaLoop FastConformer worker script; it does not include Python dependencies or model bytes. For host-specific development only, the optional `compose.practice.yml` overlay bind-mounts the configured STT venv, Python distribution directory, FastConformer model file, curated Piper runtime directory (including models), and FFmpeg binary read-only at their existing absolute paths. The host files must exist; Compose is configured not to create missing mount sources. This stages runtime assets but does not establish that speech processing is wired or live.

Use both external configuration files with Compose's multiple `--env-file` options. Supply the database-password and signing-key file paths plus the browser-facing web origin; do not load or mount `coach.env` or NousAI's `.env`:

```sh
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" \
LINGUALOOP_TOKEN_SIGNING_KEY_FILE="$HOME/.local/share/lingualoop/token-signing-key" \
docker compose --env-file "$HOME/.local/share/lingualoop/practice-models.env" \
  --env-file "$HOME/.local/share/lingualoop/practice-runtime.env" \
  -p lingualoop -f compose.postgres.yml -f compose.auth.yml -f compose.practice.yml \
  up -d --build api
```

These bind mounts are machine-specific development configuration, not a portable or production deployment. To roll back this staging, omit `compose.practice.yml`; retain the external files.

## Local PostgreSQL

The optional Compose service runs PostgreSQL 16 privately on `lingualoop-postgres-net`, with no published host port. Its `pg_isready` healthcheck proves only that PostgreSQL responds locally inside the container. The API's `/ready` endpoint checks a real database connection; login requires the explicitly provisioned Google and signing-key configuration described above.

Create the password file once. Do not regenerate it while the named data volume exists; losing the original password can make the existing database inaccessible. Create the independent token signing key once as a separate raw binary file; do not overwrite or rotate it after token issuance.

```sh
umask 077
secret_dir="$HOME/.local/share/lingualoop"
mkdir -p "$secret_dir"
token_key_file="$secret_dir/token-signing-key"
if [ -e "$token_key_file" ] || [ -L "$token_key_file" ]; then
  printf '%s\n' 'Signing-key file already exists; refusing to replace it.' >&2
  exit 1
fi
set -C # Refuse to clobber a file created between the check and redirection.
openssl rand 32 > "$token_key_file"
```

For a local API process, set `LINGUALOOP_TOKEN_SIGNING_KEY_FILE` to the absolute host path of that file (for example, `$HOME/.local/share/lingualoop/token-signing-key`); the application reads the raw bytes. The existing `LINGUALOOP_TOKEN_SIGNING_KEY` string setting remains supported for compatible environments and tests, but must not be set alongside the file setting. The optional `compose.auth.yml` overlay mounts the separately configured host file as `/run/secrets/lingualoop_token_signing_key`; its `LINGUALOOP_TOKEN_SIGNING_KEY_FILE` host variable must contain only the absolute file path. It requests mode `0400` for the mounted key. Compose file-backed secrets may ignore requested ownership/mode depending on implementation; a metadata-only check on this machine observed a regular 0600 mount for the existing host file (the requested 0400 mode was ignored). The API intentionally refuses group/other-accessible mounts rather than weakening key-file checks, so inspect the mounted file's metadata in each target runtime before enabling auth. This signing-key secret is independent from `LINGUALOOP_DB_PASSWORD_FILE`. The base `compose.postgres.yml` has no signing-key or Google-env-file requirement and supports PostgreSQL-only startup; API auth is disabled unless the optional overlay is included.

```sh
secret_dir="$HOME/.local/share/lingualoop/postgres"
secret_file="$secret_dir/password"
if docker volume inspect lingualoop-postgres-data >/dev/null 2>&1; then
  printf '%s\n' 'Refusing to create or replace the password while the database volume exists.' >&2
  exit 1
fi
umask 077
mkdir -p "$secret_dir"
if [ -e "$secret_file" ]; then
  printf '%s\n' 'Password file already exists; refusing to replace it.' >&2
  exit 1
fi
openssl rand -hex 32 > "$secret_file"
```

Start PostgreSQL only (the password is read from the host file and is never printed):

```sh
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" docker compose -p lingualoop -f compose.postgres.yml up -d postgres
```

To additionally build and start the API container on the private network, run (set `LINGUALOOP_WEB_ORIGIN` to the exact URL used by the browser; local example shown):

```sh
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" LINGUALOOP_TOKEN_SIGNING_KEY_FILE="$HOME/.local/share/lingualoop/token-signing-key" LINGUALOOP_WEB_ORIGIN="http://localhost:5001" docker compose -p lingualoop -f compose.postgres.yml -f compose.auth.yml up -d --build api
```

Compose publishes only the API on `127.0.0.1:5000`; PostgreSQL remains private. The API's `/health` reports process health only, not database connectivity. The browser uses `http://localhost:5001`, and the Vite proxy reaches the API at `http://localhost:5000` through `/api`. The IPv4 loopback Docker publish is a host bind, not the browser-facing hostname.

`LINGUALOOP_WEB_ORIGIN` is the exact browser-visible origin used to validate login/refresh/logout requests and protect session cookies. For local development it is `http://localhost:5001`; for a public deployment it should be the HTTPS URL people open in their browser. The web and API containers do not infer this public address from their private Docker network. Optional OAuth values are `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `LINGUALOOP_GOOGLE_AUDIENCE` (defaults to the Google client ID), `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and `MICROSOFT_CALLBACK_URL`. Keep client secrets in local `.env` or Portainer's stack environment and never commit them. See `.env.example` for localhost callback examples.

Start the API with the exact path-only invocation below; all variables here are host file paths, not credential values:

```sh
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" LINGUALOOP_TOKEN_SIGNING_KEY_FILE="$HOME/.local/share/lingualoop/token-signing-key" LINGUALOOP_WEB_ORIGIN="http://localhost:5001" docker compose -p lingualoop -f compose.postgres.yml -f compose.auth.yml up -d --build api
```

For a local direct API process instead of Compose, load the restricted settings into the launching shell without echoing or printing the variables, then run the API in that same shell:

```sh
set +x
set -a
set +a
cd api
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" LINGUALOOP_TOKEN_SIGNING_KEY_FILE="$HOME/.local/share/lingualoop/token-signing-key" LINGUALOOP_WEB_ORIGIN="http://localhost:5001" PORT=5000 pnpm dev
```

Keep shell tracing (`set -x`) off and never print the environment or resolved Compose configuration.

### Apply database migrations

The database has been provisioned and migrated on this machine, but a clean volume needs this migration command before use. After PostgreSQL is running and the password file exists, build the API, then run the migration CLI in a temporary Node container on PostgreSQL's private network. Both bind mounts are read-only; the password is passed by file path and is never printed or placed in an environment variable as a value. This publishes no host port:

```sh
cd api && pnpm run build && cd ..
docker run --rm --network lingualoop-postgres-net \
  --mount "type=bind,src=$PWD/api,dst=/app,readonly" \
  --mount "type=bind,src=$HOME/.local/share/lingualoop/postgres/password,dst=/run/secrets/pg_password,readonly" \
  -e LINGUALOOP_DB_PASSWORD_FILE=/run/secrets/pg_password \
  -e LINGUALOOP_DB_HOST=postgres \
  -w /app node:24-bookworm-slim node dist/db/migrate.js
```

The runner verifies SHA-256 checksums in `lingualoop_schema_migrations` and applies exactly migrations `001`–`010` in order, including owner-scoped practice sessions, the five-minute turn-lease definition, and the session-keyed practice report table. Reports require object-shaped JSON content and default to `generated_with_ai = false`. Migration 009 permits true provenance for new AI reports; migration 010 adds a per-session generation claim lease. Existing reports remain unchanged. An initial empty database reports `10 applied`; an unchanged repeat reports `0 applied`. On the existing local database, adding `005` and `006` reported `2 applied` on 2026-09-24; migration `007` updates only the reservation function's lease duration. The CLI is not run by API/Nest startup. The Nest runtime uses one shared PostgreSQL query executor for readiness and auth/practice stores; constructing stores does not query PostgreSQL. Protected practice options and owned session detail are available when local password authentication is configured. Detail includes up to 256 latest completed turns in chronological order, with each text field limited to 2,000 characters. Session creation and multipart turn submission are additionally registered only with configured local STT/Piper and a valid guarded coach key/model; these conditional routes have not been activated or live-verified on the running API. The protected `POST /language-practice/sessions/:sessionId/report` route returns existing reports unchanged. For a closed session with completed turns and no saved report, it drafts an AI report using the configured OpenAI model, outside the database transaction. An owner-scoped, two-minute claim lease prevents simultaneous requests from starting multiple calls; a crash after a paid call but before saving may still require a paid retry. A closed session with no completed turns gets a deterministic no-evidence report marked non-AI. Missing configuration, failed generation or a busy claim returns a retryable generic error, not a falsely AI-labeled fallback. `LanguagePracticeTurnService` composes required injected owner-filtered stores, bounded transcription, the coach adapter, and local synthesis; it makes no provider request on construction. Its caller-owned audio buffer contract is explicitly non-mutating, and idempotent replays return the stored turn without inference or audio. `LanguagePracticeTurnStore.listCompletedTurns(ownerId, sessionId)` is a parameterized, owner-scoped read used by owned session detail: it selects only completed turns joined through the requested owner's session, excludes failed and processing turns, retains the 256 most recent turns, and returns them chronologically. Transcript and assistant response are clipped to 2,000 characters, and each result includes its completion timestamp; owner mismatch or a missing session yields an empty list. `LanguagePracticeReportStore.getOrCreate(ownerId, sessionId)` locks and verifies the owned session before reading reports or evidence, permits only completed/expired sessions (or elapsed active sessions), and stores the deterministic fallback once. Replays return the validated original report and database creation time; evidence comes only from completed turns, and an active processing lease is failed and cleared after closure to prevent a late completion. New evidence-bearing reports can incur an OpenAI call; cached and empty-session reports do not. No audio is persisted. On 2026-10-05 the local LinguaLoop database applied migrations 009–010 (`2 applied`) and only the LinguaLoop API was recreated. Health/ready and the Vite proxy returned 200, and an unauthenticated report POST returned 401; authenticated report generation and actual model output were not tested. The report-store integration test creates a disposable PostgreSQL container and applies migrations there only, using `node --test api/test/language-practice/language-practice-report-store.spec.cjs`. The turn store is registered alongside the session store when local email/password authentication is configured; coach and turn service registration requires the additional gated runtime configuration.

For scoped local access after the container is running, open `psql` inside it:

```sh
docker exec -it lingualoop-postgres psql -U lingualoop -d lingualoop
```

Stop and remove only this Compose project's container and network; keep the named `lingualoop-postgres-data` volume (do not add `-v`):

```sh
docker compose -p lingualoop -f compose.postgres.yml down
```

## Local browser login walkthrough

The web application uses React Router routes for `/login` and `/language-practice`. Opening the root route enters the protected practice route; a session refresh runs before navigation, sending signed-out visitors to login and authenticated visitors to practice setup. Sign in with email/password, Google, or Microsoft from `/login` when configured. Provider callbacks return to the web origin with only an HttpOnly refresh cookie; the UI obtains a volatile in-memory access bearer through the normal session refresh endpoint. Use **Log out** from setup to request server-side revocation.

The setup page loads its level, topic, and duration choices from the authenticated `GET /api/language-practice/options` endpoint and starts a session through the typed `LanguagePracticeClient`; it navigates only after a valid created-session response. Protected routes connect `/language-practice/sessions/:sessionId` to owned session detail and `/language-practice/sessions/:sessionId/complete` to `PracticeReportView.vue`. The live view projects the server's remaining-time snapshot against a monotonic clock, displays saved turns, and refreshes detail on focus or when the page becomes visible. It records and submits one audio turn with a caller-stable idempotency UUID. If processing or network uncertainty leaves the result unresolved, **Check same turn** replays that exact recording and UUID; another recording is blocked until resolution, and a terminal failure requires a new turn ID. A validated bounded WAV response can be played from a revocable object URL. Expiry never triggers a new turn or report request while a turn is pending. Response DTOs are strictly bounded and public errors omit server diagnostics. Practice POSTs retry only after an explicit 401, and report retrieval makes no separate inference request from the browser. The API routes remain conditional on runtime configuration, and the running API has not been restarted or live-verified. Do not interpret a successful build as proof of deployed routes or a complete voice conversation.

## Not included

No Redis, deployment hardening, or production-grade distributed rate limiting is present. The session and completion routes are now registered behind authentication, and setup calls the conditional create-session endpoint; the running API has not been restarted to verify route availability. The live view now records and submits turns and supports bounded WAV playback, but real speech inference and browser audio acceptance remain pending. Auth-store injection is provider composition only; it does not perform store operations at startup. The HTTP adapter and internal login/refresh/logout composition have offline fake-dependency coverage; local API/DB/proxy readiness was checked previously. Local email/password login is used; refresh, logout, and manual concurrency/expiry behavior remain unaccepted. This is a shell for independently reviewed work units, not a deployable application.
