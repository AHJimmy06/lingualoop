# LinguaLoop

LinguaLoop is an independent starting point for a language-practice application. This repository contains only minimal Vue/Vite and Nest API skeletons; it is **not functional or production-ready**. No authentication, user, practice-domain, database, speech, or coaching implementation is included.

## Development

Use a current Node.js version compatible with the source project (`^20.19.0 || >=22.12.0`) and pnpm.

```sh
cd api && pnpm install && pnpm dev
cd web && pnpm install && pnpm dev
```

The API listens on `PORT`, default `3400`, and exposes `GET /health`. The web dev server defaults to `5175`; requests under `/api` are proxied to the API, with `/api/health` forwarded to `/health`.

Each app is an independent pnpm project with its own `pnpm-lock.yaml`. Both dependency installs and production builds passed locally. The web package's `pnpm-workspace.yaml` permits only the pinned `esbuild@0.28.2` install script; no other dependency build scripts are authorized. These build checks do not establish any Language Practice functionality or deployment readiness.

## Intended isolation and next steps

- Provision a new, separately credentialed database for LinguaLoop. Do not point it at the NousAI database or reuse its credentials, schema, users, or data.
- Reuse NousAI login through a server-side, short-lived identity handoff or token introspection; keep LinguaLoop practice records in its own database under a verified external subject. LinguaLoop must not copy NousAI's JWT signing secret or user table, and a practice-session UUID alone must never grant access.
- The current NousAI browser token is stored per origin, so it will not appear automatically at LinguaLoop's different port. The handoff and its origin, audience, expiry, replay and authorization checks have **not** been implemented.
- Before any future migration, back up and verify the independent target and keep the existing NousAI application, database, and volumes intact. Do not delete or alter old data as part of this scaffold; migration/removal requires separate validation and authorization.

## Configuration inventory (names only)

Only `PORT` is currently consumed by the API scaffold. Planned server-side settings are `LINGUALOOP_DB_URL`, `LINGUALOOP_REDIS_URL`, `LINGUALOOP_AUTH_ISSUER`, `LINGUALOOP_AUTH_AUDIENCE`, `LINGUALOOP_AUTH_INTROSPECTION_URL`, `LINGUALOOP_FASTCONFORMER_MODEL_PATH`, `LINGUALOOP_FASTCONFORMER_MODEL_SHA256`, `LINGUALOOP_PIPER_MODEL_EN`, `LINGUALOOP_PIPER_MODEL_ES`, `LINGUALOOP_OPENAI_MODEL` and `LINGUALOOP_OPENAI_API_KEY`. These keys do not yet configure a working integration. Use separate database credentials and server-side secret provisioning; never copy NousAI's `.env`, `JWT_SECRET`, tokens, or production database URL into this repository. No `.env` or `.env.example` has been generated.

## Not included

No database, Redis, login handoff, session authorization, speech processing, coaching, deployment configuration, or production hardening is present. This is a shell for the next independently reviewed work units, not a deployable application.
