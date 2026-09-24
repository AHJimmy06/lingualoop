# LinguaLoop

LinguaLoop is an independent starting point for a language-practice application. This repository contains minimal Vue/Vite and Nest API skeletons plus a Google login HTTP adapter; it is **not functional or production-ready**. Practice domain, speech, and coaching implementation are not included.

## Development

Use a current Node.js version compatible with the source project (`^20.19.0 || >=22.12.0`) and pnpm.

```sh
cd api && pnpm install && LINGUALOOP_DB_PASSWORD_FILE=/absolute/path/to/password PORT=5000 pnpm dev
cd web && pnpm install && pnpm dev
```

The API exposes `GET /health` as process liveness and `GET /ready` as a PostgreSQL readiness probe (`SELECT 1`); when run locally, set `PORT=5000` to match the browser-facing localhost setup (the API's standalone default remains `3400`). The Nest runtime requires `LINGUALOOP_DB_PASSWORD_FILE` to point to the existing password file. The Vite dev server binds to `localhost:5001` and proxies `/api` to `http://localhost:5000`, removing the `/api` prefix (`http://localhost:5001/api/health` reaches `/health`).

An API container image can be built with `docker build -t lingualoop-api ./api`. The Compose API service builds from that same `api/` context, listens on container port `5000`, and publishes it only on host loopback port `5000`. Its healthcheck makes an HTTP GET to `/health` using Node's built-in `fetch`, so database outages do not affect liveness. `/ready` executes `SELECT 1` and fails with HTTP 503 when PostgreSQL is unavailable. The API shares PostgreSQL's private Compose network and mounts the existing `pg_password` secret at `/run/secrets/pg_password`; only that file path is configured in the environment, never the password value. PostgreSQL has no published host port. The historical Compose API publish remains bound to IPv4 loopback `127.0.0.1:5000`; browser-facing local OAuth and Vite URLs use `localhost`.

Each app is an independent pnpm project with its own `pnpm-lock.yaml`. Build checks do not establish any Language Practice functionality or deployment readiness.

## Authentication foundation and limitations

The API contains an OAuth-state service, a verified-request guard, a LinguaLoop JWT issuer/verifier, a bounded Google ID-token identity verifier, a Google authorization-code exchange adapter, and PostgreSQL-backed identity, OAuth-state, session, and refresh stores. Nest registers all four stores against the same Nest-owned PostgreSQL query executor; constructing the providers performs no database I/O. `GoogleCodeExchange` exchanges a bounded authorization code using only the validated configured callback URL and returns an untrusted ID token; an authorization code is not an ID token, and the returned token must separately pass `GoogleIdentityService.verify` before its identity is trusted. `GoogleLoginSession` accepts only an untrusted ID token, verifies it before any store call, creates a seven-day absolute session, stores only a generated refresh-credential hash, and issues a 15-minute session-bound JWT. `GoogleAuthFlow` now composes those pieces internally: `begin()` creates one provider-bound state and a fixed Google authorization URL; `finish()` requires the matching browser cookie, atomically consumes state before exchange, passes the untrusted ID token to verified session issuance, and returns only a fixed web redirect plus cookies. When all six required settings are present and nonblank (`GOOGLE_CALLBACK_URL`, `LINGUALOOP_WEB_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINGUALOOP_GOOGLE_AUDIENCE`, and `LINGUALOOP_TOKEN_SIGNING_KEY`), Nest exposes `GET /auth/google` to begin login and `GET /auth/google/callback` for the exact configured callback. If any setting is absent or fails its runtime validation, Nest does not register the Google auth controller or its providers; `/health` and `/ready` remain available, and both auth paths return 404 rather than beginning a partial login. The adapter redirects to Google and then to the configured web origin; it delivers the refresh credential only in an HttpOnly cookie and never returns access or refresh tokens in a URL or response body. It applies no-store and browser-hardening headers, a bounded in-memory per-process start/callback limiter, and clears the state cookie on start failures and every callback error, including rate limiting. Configuration is deliberately fail-closed: the exact callback and web origin, Google client ID and secret, Google audience, and an independent LinguaLoop token-signing key are all required before auth wiring is registered. The API still makes no outbound Google request until a browser starts login. Failures after a session ID is successfully returned trigger a best-effort owner-scoped revoke; if revocation fails, the operation still rejects generically and returns no credentials. A store failure during session creation itself is outside this compensation boundary because no session ID is available to revoke. A post-issuance cookie-assembly failure also returns no credentials, but may leave an orphaned session until its seven-day expiry.

NousAI is stopped and is not an identity provider for LinguaLoop. The retained obsolete NousAI profile-introspection client/test are historical code, not a working login or handoff; they do not establish an authenticated LinguaLoop session. No token transfer from a NousAI browser session is implemented.

Google is the only planned login provider; Microsoft login is out of scope. The existing Google OAuth application registration may be reused after adding an exact LinguaLoop callback URL and provisioning its client credentials explicitly for LinguaLoop. The callback flow validates browser-bound one-time state, uses the configured callback URL for code exchange, and passes the returned untrusted ID token to the Google verifier through `GoogleLoginSession`. Before using the route, register the exact callback with Google and provision `GOOGLE_CALLBACK_URL`, `LINGUALOOP_WEB_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINGUALOOP_GOOGLE_AUDIENCE`, and `LINGUALOOP_TOKEN_SIGNING_KEY` directly in the runtime environment or secret manager; no values belong in this README or source control. For the selected localhost setup, the callback is `http://localhost:5000/auth/google/callback` and the web origin is `http://localhost:5001`. The signing key must be independently generated for LinguaLoop and at least 32 bytes. No Google registration or credential provisioning has been verified, so these routes do not establish a claim of live Google login. The in-memory limiter is per process and is not a distributed or production abuse-control mechanism. Do not copy NousAI's `.env`, signing secret, JWTs, database, schema, users, or data. Auth-store providers are wired to the LinguaLoop database adapter; no old data is migrated or removed.

### OAuth URL configuration policy

The API requires explicit `GOOGLE_CALLBACK_URL` and `LINGUALOOP_WEB_ORIGIN` values. It accepts only the exact callback path `/auth/google/callback` and one canonical web origin; public URLs must use HTTPS. HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` local development. Credentials, queries, fragments, paths on the web origin, and non-canonical or encoded callback paths are rejected. Never derive either setting from request `Host`, `Origin`, or forwarded headers. Client credentials are separate and must be provisioned explicitly; do not copy them from NousAI.

### Browser cookie and CSRF policy

`google-browser-policy.ts` requires the explicit callback and web-origin URLs, validates them with the URL policy above, and additionally requires the callback and web origin to have the same hostname and scheme. This matches the current Vite `/api` proxy topology: API requests are proxied through the web hostname, so host-only cookies set at the callback host reach the proxied API. Local development uses the same `localhost` hostname for `http://localhost:5000` and `http://localhost:5001`; mixing `localhost` and `127.0.0.1` is rejected. Public URLs use HTTPS; HTTP remains limited to configured loopback development. The internal `GoogleAuthFlow` and its Nest HTTP adapter apply this policy; no Google credentials or network call are performed at startup.

The short-lived OAuth state cookie is host-only, `HttpOnly`, `SameSite=Lax`, `Path=/`, and expires after five minutes. HTTPS uses a `__Host-` cookie name plus `Secure`; development loopback HTTP omits `Secure` and the prefix. Callback processing must reject absent, malformed, duplicate, or non-43-character-base64url state cookies, compare cookie and callback state in constant time, and only then call the supplied atomic OAuth-state consume operation. Failures share a generic message, and explicit clearing-cookie helpers use matching attributes. The refresh cookie is also host-only, `HttpOnly`, `SameSite=Lax`, and `Path=/` so proxied `/api/auth/refresh` requests carry it. Its `Max-Age` is derived from the session's original absolute `expiresAtMs` and the current `nowMs`, rounded down to whole seconds; refresh must preserve that same expiration rather than slide the seven-day session window. Expired, invalid, out-of-range, or more-than-seven-day remaining lifetimes are rejected. No access or refresh token belongs in a URL.

Future POST refresh/logout handlers must require exact `Origin` equality with the configured web origin, including its port. Missing or different Origin is rejected; the request `Host` is never a fallback. A browser has one active OAuth login attempt at a time because the state cookie has one fixed name: starting another attempt replaces the first attempt's cookie, so its callback will fail state validation. These rules are offline-tested policy only, not implemented endpoints or a claim of working login.

## Configuration inventory (names only)

Current API settings: `PORT`, `LINGUALOOP_DB_PASSWORD_FILE` (required; an absolute path to the dedicated password file), and the Google auth settings described above (`GOOGLE_CALLBACK_URL`, `LINGUALOOP_WEB_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINGUALOOP_GOOGLE_AUDIENCE`, and `LINGUALOOP_TOKEN_SIGNING_KEY`). Optional database connection settings are `LINGUALOOP_DB_HOST` (default `postgres`) and `LINGUALOOP_DB_PORT` (default `5432`). The API accepts only `postgres` or `127.0.0.1` as database host values and uses bounded connection and client-side query timeouts (`pg`'s `query_timeout`; no server-side `statement_timeout` is configured). Nest's default HTTP handling preserves standard 4xx responses and returns generic 500 responses for unknown failures; exception details are not logged. SIGTERM shutdown hooks close the Nest-owned PostgreSQL pool. The same password-file setting is used by the migration CLI.

Other future settings, not a claim that integrations are configured: `LINGUALOOP_REDIS_URL`, `LINGUALOOP_FASTCONFORMER_MODEL_PATH`, `LINGUALOOP_FASTCONFORMER_MODEL_SHA256`, `LINGUALOOP_PIPER_MODEL_EN`, `LINGUALOOP_PIPER_MODEL_ES`, `LINGUALOOP_OPENAI_MODEL`, and `LINGUALOOP_OPENAI_API_KEY`. This inventory contains names only, not values or credentials. No `.env` or `.env.example` was created or included; runtime credentials must still be provisioned independently before login.

## Local PostgreSQL

The optional Compose service runs PostgreSQL 16 privately on `lingualoop-postgres-net`, with no published host port. Its `pg_isready` healthcheck proves only that PostgreSQL responds locally inside the container. The API's `/ready` endpoint checks a real database connection; login requires the explicitly provisioned Google and signing-key configuration described above.

Create the password file once. Do not regenerate it while the named data volume exists; losing the original password can make the existing database inaccessible.

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
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" docker compose -p lingualoop -f compose.postgres.yml up -d --build api
```

Compose publishes only the API on `127.0.0.1:5000`; PostgreSQL remains private. The API's `/health` reports process health only, not database connectivity. The browser uses `http://localhost:5001`, and the Vite proxy reaches the API at `http://localhost:5000` through `/api`. The IPv4 loopback Docker publish is a host bind, not the browser-facing OAuth hostname.

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

The runner verifies the SHA-256 checksums in `lingualoop_schema_migrations` and applies exactly `001_owner_identity.sql`, `002_oauth_state.sql`, `003_auth_sessions.sql`, and `004_refresh_rotation.sql`. An initial empty database reports `4 applied`; an unchanged repeat reports `0 applied`. The CLI is not run by API/Nest startup. The Nest runtime uses one shared PostgreSQL query executor for readiness and the registered auth-store providers. Store construction does not query PostgreSQL; only actual store operations do. Authentication and login remain unwired.

For scoped local access after the container is running, open `psql` inside it:

```sh
docker exec -it lingualoop-postgres psql -U lingualoop -d lingualoop
```

Stop and remove only this Compose project's container and network; keep the named `lingualoop-postgres-data` volume (do not add `-v`):

```sh
docker compose -p lingualoop -f compose.postgres.yml down
```

## Not included

No Redis, refresh/logout endpoint, practice authorization, speech processing, coaching, deployment hardening, or production-grade distributed rate limiting is present. Auth-store injection is provider composition only; it does not perform store operations at startup. The HTTP adapter and internal login composition have offline fake-dependency coverage; no Google network request, live credential, or successful browser login was exercised. This is a shell for independently reviewed work units, not a deployable application.
