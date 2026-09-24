# LinguaLoop

LinguaLoop is an independent starting point for a language-practice application. This repository contains minimal Vue/Vite and Nest API skeletons; it is **not functional or production-ready**. No application login flow, wired database, practice domain, speech, or coaching implementation is included.

## Development

Use a current Node.js version compatible with the source project (`^20.19.0 || >=22.12.0`) and pnpm.

```sh
cd api && pnpm install && pnpm dev
cd web && pnpm install && pnpm dev
```

The API listens on `PORT`, default `3400`, and exposes `GET /health`. The web dev server defaults to `5175`; requests under `/api` are proxied to the API, with `/api/health` forwarded to `/health`.

Each app is an independent pnpm project with its own `pnpm-lock.yaml`. Build checks do not establish any Language Practice functionality or deployment readiness.

## Authentication foundation and limitations

The API contains an OAuth-state service, a verified-request guard, a LinguaLoop JWT issuer/verifier, and a bounded Google ID-token identity verifier. These are foundation components only: the Google verifier is **not wired to an OAuth callback or login endpoint**, and no real Google application registration or credentials are assumed. Auth stores and migrations exist as offline foundations, but there is no database wiring, email-based ownership, session flow, or database-backed account mapping.

NousAI is stopped and is not an identity provider for LinguaLoop. The retained obsolete NousAI profile-introspection client/test are historical code, not a working login or handoff; they do not establish an authenticated LinguaLoop session. No token transfer from a NousAI browser session is implemented.

Before login can work, the application still needs an independently authorized Google application registration and credential provisioning, an approved callback URL and callback implementation that validates state and invokes the Google verifier, a deliberate session/account model, and database wiring to a separately provisioned LinguaLoop database. Do not reuse NousAI credentials, signing secrets, database, schema, users, or data. No old data is migrated or removed.

## Configuration inventory (names only)

Current API setting: `PORT`.

Potential future settings, not a claim that integrations are configured: `LINGUALOOP_TOKEN_SIGNING_KEY`, `LINGUALOOP_GOOGLE_AUDIENCE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `LINGUALOOP_DB_URL`, `LINGUALOOP_REDIS_URL`, `LINGUALOOP_FASTCONFORMER_MODEL_PATH`, `LINGUALOOP_FASTCONFORMER_MODEL_SHA256`, `LINGUALOOP_PIPER_MODEL_EN`, `LINGUALOOP_PIPER_MODEL_ES`, `LINGUALOOP_OPENAI_MODEL`, and `LINGUALOOP_OPENAI_API_KEY`. This inventory contains names only, not values or credentials. No `.env` or `.env.example` was created or included; runtime credentials must still be provisioned independently before login.

## Local PostgreSQL

The optional Compose service runs PostgreSQL 16 privately on its dedicated network, with no published host port. Its `pg_isready` healthcheck proves only that PostgreSQL responds locally inside the container; the API running on the host cannot connect until Docker Desktop port forwarding is fixed or the API container joins `lingualoop-postgres-net`. Application database wiring and login are not implemented.

For scoped local access after the container is running, open `psql` inside it:

```sh
docker exec -it lingualoop-postgres psql -U lingualoop -d lingualoop
```

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

Start PostgreSQL (the password is read from the host file and is never printed):

```sh
LINGUALOOP_DB_PASSWORD_FILE="$HOME/.local/share/lingualoop/postgres/password" docker compose -p lingualoop -f compose.postgres.yml up -d
```

Stop and remove only this Compose project's container and network; keep the named `lingualoop-postgres-data` volume (do not add `-v`):

```sh
docker compose -p lingualoop -f compose.postgres.yml down
```

## Not included

No wired login/callback, database connection, Redis, session authorization, speech processing, coaching, deployment configuration, or production hardening is present. This is a shell for independently reviewed work units, not a deployable application.
