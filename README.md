# LinguaLoop

LinguaLoop is an independent starting point for a language-practice application. This repository contains Vue/Vite and Nest API applications, Google login, and bounded protected speech endpoints; it is **not complete or production-ready**. An inert, dependency-injected practice-turn orchestration unit exists, but is not registered or connected to an HTTP route; local speech still requires controlled real-runtime and browser acceptance.

## Development

Use a current Node.js version compatible with the source project (`^20.19.0 || >=22.12.0`) and pnpm.

```sh
cd api && pnpm install && LINGUALOOP_DB_PASSWORD_FILE=/absolute/path/to/password LINGUALOOP_TOKEN_SIGNING_KEY_FILE=/absolute/path/to/token-signing-key PORT=5000 pnpm dev
cd web && pnpm install && pnpm dev
```

The API exposes `GET /health` as process liveness and `GET /ready` as a PostgreSQL readiness probe (`SELECT 1`); when run locally, set `PORT=5000` to match the browser-facing localhost setup (the API's standalone default remains `3400`). The Nest runtime requires `LINGUALOOP_DB_PASSWORD_FILE` to point to the existing password file. The Vite dev server binds to `localhost:5001` and proxies `/api` to `http://localhost:5000`, removing the `/api` prefix (`http://localhost:5001/api/health` reaches `/health`).

An API container image can be built with `docker build -t lingualoop-api ./api`. The Compose API service builds from that same `api/` context, listens on container port `5000`, and publishes it only on host loopback port `5000`. Its healthcheck makes an HTTP GET to `/health` using Node's built-in `fetch`, so database outages do not affect liveness. `/ready` executes `SELECT 1` and fails with HTTP 503 when PostgreSQL is unavailable. The API shares PostgreSQL's private Compose network and mounts the existing `pg_password` secret at `/run/secrets/pg_password`; only that file path is configured in the environment, never the password value. PostgreSQL has no published host port. The historical Compose API publish remains bound to IPv4 loopback `127.0.0.1:5000`; browser-facing local OAuth and Vite URLs use `localhost`.

Each app is an independent pnpm project with its own `pnpm-lock.yaml`. Build checks do not establish any Language Practice functionality or deployment readiness.

## Authentication foundation and limitations

The API contains an OAuth-state service, a verified-request guard, a LinguaLoop JWT issuer/verifier, a bounded Google ID-token identity verifier, a Google authorization-code exchange adapter, and PostgreSQL-backed identity, OAuth-state, session, and refresh stores. Nest registers all four stores against the same Nest-owned PostgreSQL query executor; constructing the providers performs no database I/O. `GoogleCodeExchange` exchanges a bounded authorization code using only the validated configured callback URL and returns an untrusted ID token; an authorization code is not an ID token, and the returned token must separately pass `GoogleIdentityService.verify` before its identity is trusted. `GoogleLoginSession` accepts only an untrusted ID token, verifies it before any store call, creates a seven-day absolute session, stores only a generated refresh-credential hash, and issues a 15-minute session-bound JWT. `GoogleAuthFlow` now composes those pieces internally: `begin()` creates one provider-bound state and a fixed Google authorization URL; `finish()` requires the matching browser cookie, atomically consumes state before exchange, passes the untrusted ID token to verified session issuance, and returns only a fixed web redirect plus cookies. When all required settings are valid (`GOOGLE_CALLBACK_URL`, `LINGUALOOP_WEB_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINGUALOOP_GOOGLE_AUDIENCE`, and exactly one of `LINGUALOOP_TOKEN_SIGNING_KEY` or `LINGUALOOP_TOKEN_SIGNING_KEY_FILE`), Nest exposes `GET /auth/google` to begin login, `GET /auth/google/callback` for the exact configured callback, `POST /auth/refresh` for atomic refresh rotation, and `POST /auth/logout` for verified-session revocation. If any setting is absent or fails its runtime validation, Nest does not register the Google auth controller or its providers; `/health` and `/ready` remain available, and all auth paths return 404 rather than beginning a partial login. The login adapter redirects to Google and then to the configured web origin; it delivers the refresh credential only in an HttpOnly cookie. Refresh delivers the rotated refresh credential only in its HttpOnly cookie and the access token only in its JSON body. Credentials never appear in a URL. The web page requests refresh on load and keeps a verified access token only in volatile page memory; reload requires another refresh. Refresh calls are single-flight within the page, and ambiguous network failures are not automatically retried because refresh rotates the cookie. Logout sends the access bearer and reports success only after the server confirms revocation; if the bearer has expired it refreshes once before retrying logout. It applies no-store and browser-hardening headers, bounded in-memory per-process rate limits for start, callback, refresh, and logout, and clears the state cookie on start failures and every callback error, including rate limiting. Configuration is deliberately fail-closed: the exact callback and web origin, Google client ID and secret, Google audience, and an independent LinguaLoop token-signing key are all required before auth wiring is registered. The API still makes no outbound Google request until a browser starts login. Failures after a session ID is successfully returned trigger a best-effort owner-scoped revoke; if revocation fails, the operation still rejects generically and returns no credentials. A store failure during session creation itself is outside this compensation boundary because no session ID is available to revoke. A post-issuance cookie-assembly failure also returns no credentials, but may leave an orphaned session until its seven-day expiry.

NousAI is stopped and is not an identity provider for LinguaLoop. The retained obsolete NousAI profile-introspection client/test are historical code, not a working login or handoff; they do not establish an authenticated LinguaLoop session. No token transfer from a NousAI browser session is implemented.

Google is the only planned login provider; Microsoft login is out of scope. The existing Google OAuth application registration may be reused after adding an exact LinguaLoop callback URL and provisioning its client credentials explicitly for LinguaLoop. The callback flow validates browser-bound one-time state, uses the configured callback URL for code exchange, and passes the returned untrusted ID token to the Google verifier through `GoogleLoginSession`. Before using the route, register the exact callback with Google and provision its five runtime settings in the separate restricted host env file described below, plus one token signing key source; no credential values belong in this README or source control. Use `LINGUALOOP_TOKEN_SIGNING_KEY_FILE` with an absolute path to a raw key file of at least 32 bytes, or retain the compatible `LINGUALOOP_TOKEN_SIGNING_KEY` environment string option. Do not set both. The key is independent of the database password. Do not rotate the signing key after tokens have been issued: existing tokens would stop verifying. For the selected localhost setup, the callback is `http://localhost:5000/auth/google/callback` and the web origin is `http://localhost:5001`. The signing key must be independently generated for LinguaLoop and at least 32 bytes. The user reported successful browser Google sign-in after the fetch fix. Refresh, logout, and manual concurrency/expiry acceptance remain pending; offline configuration and tests do not establish those behaviors. The in-memory limiter is per process and is not a distributed or production abuse-control mechanism. Do not copy NousAI's `.env`, signing secret, JWTs, database, schema, users, or data. Auth-store providers are wired to the LinguaLoop database adapter; no old data is migrated or removed.

### OAuth URL configuration policy

The API requires explicit `GOOGLE_CALLBACK_URL` and `LINGUALOOP_WEB_ORIGIN` values. It accepts only the exact callback path `/auth/google/callback` and one canonical web origin; public URLs must use HTTPS. HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` local development. Credentials, queries, fragments, paths on the web origin, and non-canonical or encoded callback paths are rejected. Never derive either setting from request `Host`, `Origin`, or forwarded headers. Reuse the existing Google OAuth client ID and secret through explicit LinguaLoop runtime provisioning; do not copy NousAI's entire `.env` or its JWT signing key.

### Browser cookie and CSRF policy

`google-browser-policy.ts` requires the explicit callback and web-origin URLs, validates them with the URL policy above, and additionally requires the callback and web origin to have the same hostname and scheme. This matches the current Vite `/api` proxy topology: API requests are proxied through the web hostname, so host-only cookies set at the callback host reach the proxied API. Local development uses the same `localhost` hostname for `http://localhost:5000` and `http://localhost:5001`; mixing `localhost` and `127.0.0.1` is rejected. Public URLs use HTTPS; HTTP remains limited to configured loopback development. The internal `GoogleAuthFlow` and its Nest HTTP adapter apply this policy; no Google credentials or network call are performed at startup.

The short-lived OAuth state cookie is host-only, `HttpOnly`, `SameSite=Lax`, `Path=/`, and expires after five minutes. HTTPS uses a `__Host-` cookie name plus `Secure`; development loopback HTTP omits `Secure` and the prefix. Callback processing must reject absent, malformed, duplicate, or non-43-character-base64url state cookies, compare cookie and callback state in constant time, and only then call the supplied atomic OAuth-state consume operation. Failures share a generic message, and explicit clearing-cookie helpers use matching attributes. The refresh cookie is also host-only, `HttpOnly`, `SameSite=Lax`, and `Path=/` so proxied `/api/auth/refresh` requests carry it. Its `Max-Age` is derived from the session's original absolute `expiresAtMs` and the current `nowMs`, rounded down to whole seconds; refresh must preserve that same expiration rather than slide the seven-day session window. Expired, invalid, out-of-range, or more-than-seven-day remaining lifetimes are rejected. No access or refresh token belongs in a URL.

`POST /auth/logout` is mounted only when the complete Google/token configuration is valid and is the only route guarded by `VerifiedRequestGuard`; Google start, callback, and refresh remain public. Logout requires an exact configured `Origin` and a verified bearer JWT whose owner and active session are resolved by the existing identity/session stores. It never trusts a refresh-cookie UUID as owner identity. If the refresh cookie is present, its strict credential format and session UUID must match the verified JWT session before revocation; malformed, duplicate, or mismatched cookies do not revoke. Without a refresh cookie, the verified owner/session is still revoked. Allowed-origin responses clear the refresh cookie and return generic failures with safe no-store headers; cross-origin requests neither clear the cookie nor mutate the session. Revocation is owner/session scoped through `RefreshSession.logout`. A repeated logout is not guaranteed to be HTTP-idempotent: after revocation, the guard may reject the same JWT with 401 before the handler runs. If the access JWT has expired, refresh first. If the client needs to clear an invalid refresh cookie after that guard-level 401, it can call `POST /auth/refresh` on the configured origin; refresh failures clear the cookie.

`POST /auth/refresh` is mounted only when the complete Google/token configuration is valid. It checks exact configured `Origin` equality before parsing cookies or invoking the refresh service; absent, `null`, different scheme, host, or port receives a generic 403 without clearing the browser cookie. On the allowed origin it requires one syntactically valid refresh cookie, delegates its single-use atomic rotation to `RefreshSession`, replaces the host-only HttpOnly cookie with the same absolute session expiry, and returns the 15-minute access JWT only in a no-store JSON body. Invalid credentials, spent replay, and rotation failures return one generic error and clear the refresh cookie; database migration 004 revokes the session on spent-hash replay. Do not concurrently retry an old refresh credential: a losing concurrent request can trigger spent-hash replay revocation of the session. Rate limiting is bounded in-memory per API process and keyed on the socket peer IP, never forwarded headers; it is not a distributed or production-grade abuse control. Access and refresh credentials are never logged or placed in URLs. A browser client must keep the access bearer only in volatile JavaScript memory, not local/session storage; after reload it may request a fresh bearer with the HttpOnly refresh cookie. A browser has one active OAuth login attempt at a time because the state cookie has one fixed name: starting another attempt replaces the first attempt's cookie, so its callback will fail state validation.

## Configuration inventory (names only)

Current API settings: `PORT`, `LINGUALOOP_DB_PASSWORD_FILE` (required; an absolute path to the dedicated password file), `LINGUALOOP_TOKEN_SIGNING_KEY_FILE` (absolute path to a raw 32+ byte signing-key file) or the compatible `LINGUALOOP_TOKEN_SIGNING_KEY` environment string (exactly one), and the Google auth settings described above (`GOOGLE_CALLBACK_URL`, `LINGUALOOP_WEB_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `LINGUALOOP_GOOGLE_AUDIENCE`). The signing key file path setting contains only a path, never key content. Optional database connection settings are `LINGUALOOP_DB_HOST` (default `postgres`) and `LINGUALOOP_DB_PORT` (default `5432`). The API accepts only `postgres` or `127.0.0.1` as database host values and uses bounded connection and client-side query timeouts (`pg`'s `query_timeout`; no server-side `statement_timeout` is configured). Nest's default HTTP handling preserves standard 4xx responses and returns generic 500 responses for unknown failures; exception details are not logged. SIGTERM shutdown hooks close the Nest-owned PostgreSQL pool. The same password-file setting is used by the migration CLI.

Optional local speech settings are listed in the private runtime section below; they do not imply that models are mounted or inference has been accepted. The coach provider/configuration slice recognizes `LINGUALOOP_OPENAI_API_KEY_FILE` and `LANGUAGE_PRACTICE_OPENAI_MODEL`, but it is deliberately not registered or activated; no coach request or paid report call is currently possible through the application. `LINGUALOOP_REDIS_URL`, `LINGUALOOP_OPENAI_MODEL`, and `LINGUALOOP_OPENAI_API_KEY` are not runtime settings. This inventory contains names only, not values or credentials. No repository `.env` or `.env.example` was created or included; the provisioned private external env files are documented below.

### Optional protected speech transcription

Two private files were provisioned outside the repository with mode `0600`: `~/.local/share/lingualoop/coach.env` contains only `OPENAI_API_KEY`; `~/.local/share/lingualoop/practice-models.env` contains only `LANGUAGE_PRACTICE_OPENAI_MODEL`, `LANGUAGE_PRACTICE_FASTCONFORMER_MODEL_PATH`, `LANGUAGE_PRACTICE_FASTCONFORMER_MODEL_SHA256`, `LANGUAGE_PRACTICE_PIPER_PATH`, `LANGUAGE_PRACTICE_PIPER_MODEL_EN`, `LANGUAGE_PRACTICE_PIPER_MODEL_ES`, `LANGUAGE_PRACTICE_FFMPEG_PATH`, `LINGUALOOP_PIPER_MODEL_EN_SHA256`, `LINGUALOOP_PIPER_SIDECAR_EN_SHA256`, `LINGUALOOP_PIPER_MODEL_ES_SHA256`, and `LINGUALOOP_PIPER_SIDECAR_ES_SHA256`. Do not reuse NousAI's whole `.env`, JWT/signing key, database, or data. No paid inference calls are authorized; obtain fresh explicit authorization before any paid call.

When complete Google authentication and the exact FastConformer/FFmpeg runtime settings are valid, the API additionally mounts `POST /practice/transcribe`. It requires the verified Google bearer session and accepts only raw `audio/webm`, `audio/webm;codecs=opus`, `audio/ogg`, `audio/ogg;codecs=opus`, `audio/wav`, `audio/x-wav`, or `audio/mp4` bodies up to 2 MiB. The route permits one active preparation/transcription per API process, prepares a private temporary WAV, and returns only `{ "transcript": "..." }` with no-store headers after success. Authentication, size, media-type, preparation, and inference failures remain generic. The feature does not accept multipart, trust caller-provided owner/session IDs or cookies, persist audio/transcripts, invoke coaching/Piper, or make paid calls. Health-only or incomplete configuration does not expose the route. Automated HTTP tests use fake preparation/transcription providers; they do not establish a real FFmpeg/model inference or runtime acceptance.

### Optional protected Piper synthesis

When complete Google authentication and the Piper executable, both `.onnx` model paths, and all four model/sidecar SHA-256 settings are valid, the API independently mounts `POST /practice/synthesize`; FastConformer/FFmpeg settings are not required. It requires the verified owner/session bearer and exactly `{ "language": "en"|"es", "text": "..." }`, with a 500-character limit and no control characters or extra fields. Only one synthesis runs per API process at a time. Success returns the Piper host's artifact-validated WAV bytes as `audio/wav`; errors are generic and responses are not cached. Piper processes and model verification start lazily on the first request, not during API startup. No audio/text is persisted and this route does not invoke coaching or paid services. Automated HTTP tests use fake hosts; real model and browser playback acceptance remain pending.

The configured hashes pin the local files observed at provisioning time; they do not establish publisher provenance. The optional practice runtime overlay below loads only the path and model settings from these files and mounts the listed host artifacts read-only. Keep these external files intact when rolling back by omitting the overlay.

### Inert coach provider configuration (not activated)

The bounded coach slice has an OpenAI Responses adapter factory, but the API module does not register or construct it. The factory accepts only an explicit absolute key-file path and `LANGUAGE_PRACTICE_OPENAI_MODEL` equal to `gpt-5.6-luna` or `gpt-6-luna`; it requires exactly one non-empty `OPENAI_API_KEY=` line in the external key file, rejects group/world-accessible files, and creates an SDK client configured with zero retries and a 90-second timeout. The existing `CoachAdapter` makes one Responses request per invocation. This does not add a practice-turn route: a future route must first verify the owner/session and enforce a one-call-per-turn budget. No paid report call is supported or authorized by this slice.

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

Use both external configuration files with Compose's multiple `--env-file` options. Supply the existing database, signing-key, and Google-auth file paths as usual; do not load or mount `coach.env` or NousAI's `.env`:

```sh
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" \
LINGUALOOP_TOKEN_SIGNING_KEY_FILE="$HOME/.local/share/lingualoop/token-signing-key" \
LINGUALOOP_GOOGLE_ENV_FILE="$HOME/.local/share/lingualoop/google-oauth.env" \
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

To additionally build and start the API container on the private network, run:

```sh
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" LINGUALOOP_TOKEN_SIGNING_KEY_FILE="$HOME/.local/share/lingualoop/token-signing-key" docker compose -p lingualoop -f compose.postgres.yml -f compose.auth.yml up -d --build api
```

Compose publishes only the API on `127.0.0.1:5000`; PostgreSQL remains private. The API's `/health` reports process health only, not database connectivity. The browser uses `http://localhost:5001`, and the Vite proxy reaches the API at `http://localhost:5000` through `/api`. The IPv4 loopback Docker publish is a host bind, not the browser-facing OAuth hostname.

The optional auth overlay also requires a separate Google settings env file outside the repository. Create `~/.local/share/lingualoop/google-oauth.env` with mode `0600`, containing only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINGUALOOP_GOOGLE_AUDIENCE` (the client ID), `GOOGLE_CALLBACK_URL` (`http://localhost:5000/auth/google/callback`), and `LINGUALOOP_WEB_ORIGIN` (`http://localhost:5001`). Reuse the existing Google OAuth client credentials only in this LinguaLoop-specific file; never copy NousAI's whole `.env`, or share its JWTs or database. The overlay passes this file to the API only; the base PostgreSQL-only Compose configuration does not load it. Docker `env_file` values are visible to Docker-daemon administrators through container inspection, so use this only where daemon access is trusted.

Start the API with the exact path-only invocation below; all variables here are host file paths, not credential values:

```sh
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" LINGUALOOP_TOKEN_SIGNING_KEY_FILE="$HOME/.local/share/lingualoop/token-signing-key" LINGUALOOP_GOOGLE_ENV_FILE="$HOME/.local/share/lingualoop/google-oauth.env" docker compose -p lingualoop -f compose.postgres.yml -f compose.auth.yml up -d --build api
```

For a local direct API process instead of Compose, load the restricted settings into the launching shell without echoing or printing the variables, then run the API in that same shell:

```sh
set +x
set -a
. "$HOME/.local/share/lingualoop/google-oauth.env"
set +a
cd api
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" LINGUALOOP_TOKEN_SIGNING_KEY_FILE="$HOME/.local/share/lingualoop/token-signing-key" PORT=5000 pnpm dev
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

The runner verifies SHA-256 checksums in `lingualoop_schema_migrations` and applies exactly migrations `001`–`007` in order, including owner-scoped practice sessions and the five-minute turn-lease definition. An initial empty database reports `7 applied`; an unchanged repeat reports `0 applied`. On the existing local database, adding `005` and `006` reported `2 applied` on 2026-09-24; migration `007` updates only the reservation function's lease duration. The CLI is not run by API/Nest startup. The Nest runtime uses one shared PostgreSQL query executor for readiness and auth/practice stores; constructing stores does not query PostgreSQL. Only protected practice options and owned session detail are exposed: creating sessions, processing turns, coaching, and reports are not yet connected. The unregistered `LanguagePracticeTurnService` composes required injected owner-filtered stores, bounded transcription, the coach adapter, and local synthesis; it performs no provider construction or network work itself. Its caller-owned audio buffer contract is explicitly non-mutating, and idempotent replays return the stored turn without inference or audio. `LanguagePracticeTurnStore.getCompletedHistory(ownerId, sessionId)` is an inert, parameterized, owner-scoped read: it selects only completed turns joined through the requested owner's session, excludes failed and processing turns, retains the ten most recent turns but returns those learner/assistant pairs in chronological order. Each message is clipped to 2,000 characters (at most 20 entries); owner mismatch or a missing session yields empty history. Callers must separately verify the owned session context before using history; the store remains unregistered in the application.

For scoped local access after the container is running, open `psql` inside it:

```sh
docker exec -it lingualoop-postgres psql -U lingualoop -d lingualoop
```

Stop and remove only this Compose project's container and network; keep the named `lingualoop-postgres-data` volume (do not add `-v`):

```sh
docker compose -p lingualoop -f compose.postgres.yml down
```

## Local browser login walkthrough

The web application has separate Vue Router routes for `/login` and `/language-practice`. Opening the root route enters the protected practice route; a session refresh runs before navigation, sending signed-out visitors to login and authenticated visitors to practice setup. Sign in with Google from `/login`. The callback returns to the web origin, where the refresh cookie is exchanged for a volatile in-memory access bearer. Use **Log out** from setup to request server-side revocation; the page clears its local practice state and returns to login, and it reports when the server could not confirm revocation.

The setup page loads its level, topic, and duration choices from the authenticated `GET /api/language-practice/options` endpoint, with one refresh-and-retry after an expired bearer. Choices are selectable but not saved. Session creation is intentionally unavailable: the API does not expose the create endpoint until the protected conversation turn flow is ready. There is no recorder, standalone transcription, or text-to-speech form on these routes. Real timed conversation, coaching, and completion/report integration remain pending; do not interpret setup options or a successful build as a practice session.

## Not included

No Redis, create-session endpoint, protected timed conversation/turn flow, coaching, completion report UI, deployment hardening, or production-grade distributed rate limiting is present. The protected transcribe and Piper synthesis modules remain for later turn integration but are not used by the current login/setup UI. Real speech inference and browser audio acceptance remain pending. Auth-store injection is provider composition only; it does not perform store operations at startup. The HTTP adapter and internal login/refresh/logout composition have offline fake-dependency coverage; local API/DB/proxy readiness and Google authorization initiation passed without following the redirect. The user reported successful browser Google sign-in after the fetch fix; refresh, logout, and manual concurrency/expiry behavior remain unaccepted. This is a shell for independently reviewed work units, not a deployable application.
