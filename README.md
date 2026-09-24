# LinguaLoop

LinguaLoop is an independent starting point for a language-practice application. This repository contains minimal Vue/Vite and Nest API skeletons; it is **not functional or production-ready**. No application login flow or application-to-database wiring, practice domain, speech, or coaching implementation is included.

## Development

Use a current Node.js version compatible with the source project (`^20.19.0 || >=22.12.0`) and pnpm.

```sh
cd api && pnpm install && LINGUALOOP_DB_PASSWORD_FILE=/absolute/path/to/password PORT=5000 pnpm dev
cd web && pnpm install && pnpm dev
```

The API exposes `GET /health` as process liveness and `GET /ready` as a PostgreSQL readiness probe (`SELECT 1`); when run locally, set `PORT=5000` to match the web proxy (the API's standalone default remains `3400`). The Nest runtime requires `LINGUALOOP_DB_PASSWORD_FILE` to point to the existing password file. The Vite dev server binds to `127.0.0.1:5001` and proxies `/api` to `http://127.0.0.1:5000`, removing the `/api` prefix (`/api/health` reaches `/health`).

An API container image can be built with `docker build -t lingualoop-api ./api`. The Compose API service builds from that same `api/` context, listens on container port `5000`, and publishes it only on host loopback port `5000`. Its healthcheck makes an HTTP GET to `/health` using Node's built-in `fetch`, so database outages do not affect liveness. `/ready` executes `SELECT 1` and fails with HTTP 503 when PostgreSQL is unavailable. The API shares PostgreSQL's private Compose network and mounts the existing `pg_password` secret at `/run/secrets/pg_password`; only that file path is configured in the environment, never the password value. PostgreSQL has no published host port.

Each app is an independent pnpm project with its own `pnpm-lock.yaml`. Build checks do not establish any Language Practice functionality or deployment readiness.

## Authentication foundation and limitations

The API contains an OAuth-state service, a verified-request guard, a LinguaLoop JWT issuer/verifier, and a bounded Google ID-token identity verifier. These are foundation components only: the Google verifier is **not wired to an OAuth callback or login endpoint**, and no real Google application registration or credentials are assumed. Auth stores and migrations exist, but there is no application database wiring, email-based ownership, session flow, or database-backed account mapping.

NousAI is stopped and is not an identity provider for LinguaLoop. The retained obsolete NousAI profile-introspection client/test are historical code, not a working login or handoff; they do not establish an authenticated LinguaLoop session. No token transfer from a NousAI browser session is implemented.

Google is the only planned login provider; Microsoft login is out of scope. The existing Google OAuth application registration may be reused after adding an exact LinguaLoop callback URL and provisioning its client credentials explicitly for LinguaLoop. The callback must validate one-time state and invoke the Google verifier. Do not copy NousAI's `.env`, signing secret, JWTs, database, schema, users, or data. Session/account and auth-store wiring are still needed; no old data is migrated or removed.

## Configuration inventory (names only)

Current API settings: `PORT` and `LINGUALOOP_DB_PASSWORD_FILE` (required; an absolute path to the dedicated password file). Optional database connection settings are `LINGUALOOP_DB_HOST` (default `postgres`) and `LINGUALOOP_DB_PORT` (default `5432`). The API accepts only `postgres` or `127.0.0.1` as database host values and uses bounded connection and client-side query timeouts (`pg`'s `query_timeout`; no server-side `statement_timeout` is configured). Nest's default HTTP handling preserves standard 4xx responses and returns generic 500 responses for unknown failures; exception details are not logged. SIGTERM shutdown hooks close the Nest-owned PostgreSQL pool. The same password-file setting is used by the migration CLI.

Potential future settings, not a claim that integrations are configured: `LINGUALOOP_TOKEN_SIGNING_KEY`, `LINGUALOOP_GOOGLE_AUDIENCE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `LINGUALOOP_REDIS_URL`, `LINGUALOOP_FASTCONFORMER_MODEL_PATH`, `LINGUALOOP_FASTCONFORMER_MODEL_SHA256`, `LINGUALOOP_PIPER_MODEL_EN`, `LINGUALOOP_PIPER_MODEL_ES`, `LINGUALOOP_OPENAI_MODEL`, and `LINGUALOOP_OPENAI_API_KEY`. This inventory contains names only, not values or credentials. No `.env` or `.env.example` was created or included; runtime credentials must still be provisioned independently before login.

## Local PostgreSQL

The optional Compose service runs PostgreSQL 16 privately on `lingualoop-postgres-net`, with no published host port. Its `pg_isready` healthcheck proves only that PostgreSQL responds locally inside the container. The API's `/ready` endpoint checks a real database connection; login remains unwired.

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

Compose publishes only the API on `127.0.0.1:5000`; PostgreSQL remains private. The API's `/health` reports process health only, not database connectivity. The Vite server can then reach it through `/api` on port `5001`.

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

The runner verifies the SHA-256 checksums in `lingualoop_schema_migrations` and applies exactly `001_owner_identity.sql`, `002_oauth_state.sql`, `003_auth_sessions.sql`, and `004_refresh_rotation.sql`. An initial empty database reports `4 applied`; an unchanged repeat reports `0 applied`. The CLI is not run by API/Nest startup. The Nest runtime uses the shared PostgreSQL query executor for readiness only; authentication and login remain unwired.

For scoped local access after the container is running, open `psql` inside it:

```sh
docker exec -it lingualoop-postgres psql -U lingualoop -d lingualoop
```

Stop and remove only this Compose project's container and network; keep the named `lingualoop-postgres-data` volume (do not add `-v`):

```sh
docker compose -p lingualoop -f compose.postgres.yml down
```

## Not included

No wired login/callback, auth-store injection, Redis, session authorization, speech processing, coaching, deployment configuration, or production hardening is present. This is a shell for independently reviewed work units, not a deployable application.
