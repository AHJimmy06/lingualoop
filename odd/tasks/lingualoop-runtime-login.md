# LinguaLoop runtime and login continuation

## Objective and authority
Independent local LinguaLoop: Google-only login, revocable sessions, original protected voice-and-coach practice and browser acceptance. Full source plan: `/home/jimmy/NousAI/edu-assistant/odd/tasks/extract-lingualoop.md`. Earlier task/evidence narrative remains in Git at `ee0608b:odd/tasks/lingualoop-runtime-login.md`; preserve those decisions and limitations. Branch is local; no push or PR.

## Boundaries
API `localhost:5000`, Vue `localhost:5001`, private LinguaLoop PostgreSQL. Preserve NousAI, its DB/data/secrets, the existing modified `.gitignore`, and unrelated untracked files. Reuse only explicitly authorized NousAI Google client ID/secret and coach `OPENAI_API_KEY`, stored separately outside the repository in 0600 LinguaLoop files; never reuse NousAI JWT/DB/tokens or copy entire `.env`. Independent LinguaLoop signing key. No paid coach inference without fresh approval; no deletion or retirement before user acceptance. Prior choice: TDD off; RDD switch off. User prefers a working browser flow over more offline tests. Commit each bounded unit locally with checks; disclose runtime gaps rather than claiming inference from package-discovery/fake tests.

## Task checklist (local commit evidence)
- [x] LL-2-R1 — Docker API/private network/Vite proxy; host health smoke. `b3f3786`.
- [x] LL-2-R2a — DB readiness and safe 503. `16340f3`.
- [x] LL-2-R2b — Shared executor and four injected auth stores. `1edba57`.
- [x] LL-2-R3a — Exact fail-closed Google callback/web origin. `c74e096`.
- [x] LL-2-R3-URL — User registered localhost:5000 callback and confirmed real browser Google sign-in on 2026-09-24.
- [x] LL-2-R3-CLIENT — Reused only Google ID/secret in isolated 0600 env and optional overlay. `af1d744`.
- [x] LL-2-R3-KEY — Independent external 0600 signing key. `fe5337c`.
- [x] LL-2-R3-LOCAL — Browser localhost topology. `82b499d`.
- [x] LL-2-R3b-HTTP — Conditional Nest Google start/callback, state cookie, limits. `9a5677c`; internals `3989938`, `f88cb9d`, `198fb97`, `d0d3080`.
- [x] LL-2-R3b — User-reported actual signed-in browser state (not DB/console inspection).
- [x] LL-2-R3c-CORE — Atomic refresh rotation and scoped revocation. `19651fe`.
- [x] LL-2-R3c-REFRESH — Exact-Origin refresh and rotating HttpOnly cookie. `a54733a`.
- [x] LL-2-R3c-LOGOUT — Guarded owner/session logout. `d694f13`.
- [ ] LL-2-R3c — Browser refresh/logout, concurrent-use and absolute-expiry acceptance. Expired bearer may need refresh before guarded logout; offline tests alone insufficient.
- [x] LL-4-AUTH — Vue login/session UI `3af4a36`, bound browser fetch fix `d5c51d5`; headless Chromium observed actual refresh 401/no-cookie and signed-out, user confirmed real Google login.
- [x] LL-3-CONFIG — Authorized coach key only in external 0600 `coach.env`; voice settings and local SHA pins in separate 0600 `practice-models.env`. `1cfba90`. No paid call.
- [x] LL-3-VOICE-RUNTIME — Optional read-only local STT/Piper/FFmpeg overlay; Docker worker and executable/package-discovery network-none smoke. `a344a0d`. No inference; NeMo host import exceeded 30s probe.
- [x] LL-3-VOICE-BOOT — Nest runtime only with valid Google/voice config; lazy FastConformerHost and FFmpeg token, shutdown hook, no startup model load. `ed618ff`; API build, 3 tests and independent verification. Nest lifecycle dispatch and actual model startup unverified.
- [x] LL-3-VOICE-STT-HTTP — Authenticated POST `/practice/transcribe` with raw allowlisted MIME, <=2 MiB declared/streamed body, one active FFmpeg+FastConformer slot, private temp WAV cleanup and safe JSON transcript/errors; no coach/storage. `1c31ea8`; API build, 6 focused fake-provider HTTP tests, independent verifier and diff check passed. Pre-body abort fixed in review; real FFmpeg/inference and actual browser mic still unverified. Route exists only with both auth and voice runtime config. Rollback only this unit.
- [ ] LL-3-VOICE-MIC — Next: small Vue microphone recording and user-triggered transcription via current protected access bearer. Verify permission denial/unsupported format, upload timeout and visible transcript/error; no fake feedback, coach or paid calls. Do not restart user API/Vite until a controlled activation step. Allowed surfaces `web/src/App.vue`, `web/src/auth-session.ts` if needed, `web/src/practice-audio.ts`, `web/src/**/*.spec.ts` focused if useful, `README.md` for user steps. Keep work unit reviewable.
- [ ] LL-3-VOICE — Piper output route and client playback as separate slice after mic; real local speech acceptance, not just mocks. Existing runtime staging is not evidence of successful model inference.
- [ ] LL-3-COACH — Validated bounded structured coach inference behind owner/session; require fresh approval before any real paid call. No key logging.
- [ ] LL-3 — Original complete protected voice-and-coach turn/report with own storage and browser acceptance. No self-guided text substitute.
- [ ] LL-4 — Remaining Vue practice/report/session integration.
- [ ] LL-5 — Isolated end-to-end auth/practice acceptance while NousAI untouched.
- [ ] LL-6 — After explicit acceptance only, reversibly retire old NousAI practice imports/services; do not delete data.

## Current evidence and immediate next step
2026-09-24 `LL-3-VOICE-STT-HTTP`: writer added conditional route/service and five fake-provider HTTP checks; parent found an aborted-zero-body Promise leak and corrected it with a sixth regression. Parent/independent verifier observed API build, 6/6 tests and diff check passing. One verifier initially ran `npm run build` at repository root and got no package.json, then `npm --prefix api run build` passed; no candidate failure. Local `1c31ea8`. No real model/audio run or API restart; existing localhost API/Vite sessions preserved. `LL-3-VOICE-MIC` next gives visible user-owned browser mic capture, but backend only exposes route when optional practice overlay is active; controlled activation and runtime acceptance remain separate. API worker startup max 30 seconds, and host NeMo import previously exceeded 30 seconds; be honest if first live transcription fails. No paid coach call until fresh user approval.
