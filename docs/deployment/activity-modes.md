# Activity modes and English reports (local change)

Create practice accepts optional `activity: { mode: "conversation" | "single-response", aiRole: string (0..500), location: string (0..1000) }`. These fields describe fictional context, never privileged instructions. Omission preserves conversation mode for old callers. New practices and sessions return the configuration; custom sessions copy a durable snapshot. Existing sessions use conversation defaults.

Single response: manual recording/stop, one successful persisted learner response, no conversation coach/TTS, automatic atomic session completion, then report. Failed processing can be retried with a new turn id; uncertain requests must replay the same id. The database serializes admission and enforces single completed response across concurrent tabs and retries. Existing completed-id replays remain available after closure.

Recording is manually stopped (no silence cutoff), with technical safety caps: 10 minutes / 32 MiB compressed audio, 30,000 transcript characters. These are not assessment time limits. Single-response sessions use a 24-hour submission window, not the conversation timer; navigation does not persist an unsent recording. Audio duration is checked after decoding; overlong input is rejected, never silently truncated. Processing timeouts remain bounded and failures retryable.

All newly generated report prose (including goal explanations) is English. Historical reports are preserved (content, goal coverage, provenance and date) in legacy_content when the student next explicitly requests the report via POST; that request may generate a new English report using the durable claim. GETs do not generate or translate reports. User-authored goals retain their original text. Existing Spanish correction evidence is internal source material, not displayed as English feedback. No pronunciation assessment from STT text.

Migration 017 is required before running new code. No production migration or deployment is performed by this implementation.

Conversation timers prevent starting new recordings in the UI, but an active session accepts submission within a 12-minute grace period after its nominal expiry so a long response is not rejected merely because recording crossed the timer. Closed sessions remain closed.

## Local validation on 2026-10-27
The user confirmed the 10-minute safety cap. Migration 017 was applied to the existing local database at 127.0.0.1:5544 (16 previous migrations; one applied). Production was not contacted. API local validation binds 127.0.0.1 using LINGUALOOP_BIND_HOST=127.0.0.1; the unspecified container binding remains unchanged. Native STT /ready and API /health,/ready all returned 200.
Two clearly named local validation activities were created with the user-provided walking/choir image and separate conversation/single-response contexts. Browser microphone verification requires the user's actual speech; automated or synthetic audio must not be reported as a real microphone acceptance test.

## Student instructions and empty exits
The live view keeps the teacher's image complete and available after reload. Requirements open from a right-aligned icon in the conversation header, in an `Activity instructions` dialog. Teacher-only AI role and setting are not rendered to students.

With no completed speaking responses, the session action is `Exit practice`. The existing finish POST discards the owned session and returns `{ id, status: "DISCARDED" }`; the client returns to the catalogue without requesting a report. The database locks the owned session before checking completed turns and the active processing lease. A processing turn blocks discard with 409, and a session with completed responses retains the normal finish/report flow. No new migration is needed for this action.

## Release procedure
Push to `develop`, integrate into `main`, and wait for the `Publish LinguaLoop images to GHCR` workflow. Validate builds and API/web tests before pushing; the existing workflow builds and publishes the images. Successful image jobs publish both `latest` and the exact Git commit SHA; prefer the SHA tag to deploy a matched API/web pair.

Publishing images does not migrate or redeploy the server. Before starting the new API on an existing installation, back up the database and run migration 017 with the release image's migration CLI and the existing production database configuration. Do not change an already-applied migration checksum. The migration is additive and its local disposable-database tests also verify an unchanged rerun applies zero migrations.

A real microphone acceptance test remains pending user availability; automated HTTP/STT simulations are not evidence of actual speech recognition or live paid model quality.
