# LinguaLoop

LinguaLoop is an independent starting point for a language-practice application. This repository contains minimal Vue/Vite and Nest API skeletons; it is **not functional or production-ready**. No application login flow, user store, practice domain, database, speech, or coaching implementation is included.

## Development

Use a current Node.js version compatible with the source project (`^20.19.0 || >=22.12.0`) and pnpm.

```sh
cd api && pnpm install && pnpm dev
cd web && pnpm install && pnpm dev
```

The API listens on `PORT`, default `3400`, and exposes `GET /health`. The web dev server defaults to `5175`; requests under `/api` are proxied to the API, with `/api/health` forwarded to `/health`.

Each app is an independent pnpm project with its own `pnpm-lock.yaml`. Build checks do not establish any Language Practice functionality or deployment readiness.

## Authentication foundation and limitations

The API contains an OAuth-state service, a verified-request guard, a LinguaLoop JWT issuer/verifier, and a bounded Google ID-token identity verifier. These are foundation components only: the Google verifier is **not wired to an OAuth callback or login endpoint**, and no real Google application registration or credentials are assumed. There is no user table, email-based ownership, session flow, or database-backed account mapping.

NousAI is stopped and is not an identity provider for LinguaLoop. The retained obsolete NousAI profile-introspection client/test are historical code, not a working login or handoff; they do not establish an authenticated LinguaLoop session. No token transfer from a NousAI browser session is implemented.

Before login can work, the application still needs an independently authorized Google application registration and credential provisioning, an approved callback URL and callback implementation that validates state and invokes the Google verifier, a deliberate session/account model, and a separately provisioned LinguaLoop database. Do not reuse NousAI credentials, signing secrets, database, schema, users, or data. No migration or removal of old data is included.

## Configuration inventory (names only)

Current API setting: `PORT`.

Potential future settings, not a claim that integrations are configured: `LINGUALOOP_TOKEN_SIGNING_KEY`, `LINGUALOOP_GOOGLE_AUDIENCE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `LINGUALOOP_DB_URL`, `LINGUALOOP_REDIS_URL`, `LINGUALOOP_FASTCONFORMER_MODEL_PATH`, `LINGUALOOP_FASTCONFORMER_MODEL_SHA256`, `LINGUALOOP_PIPER_MODEL_EN`, `LINGUALOOP_PIPER_MODEL_ES`, `LINGUALOOP_OPENAI_MODEL`, and `LINGUALOOP_OPENAI_API_KEY`. This inventory contains names only, not values or credentials. No `.env` or `.env.example` was created or included; runtime credentials must still be provisioned independently before login.

## Not included

No wired login/callback, database, Redis, session authorization, speech processing, coaching, deployment configuration, or production hardening is present. This is a shell for independently reviewed work units, not a deployable application.
