# Local activity validation — 2026-10-27

## Scope
Only the existing local Docker Desktop database (127.0.0.1:5544), native API (127.0.0.1:5000), Vite (localhost:5001) and native STT (127.0.0.1:8080). No SSH, remote deployment, production migration or production browser interaction.

## Passed
- User confirmed a 10-minute recording safety cap.
- Existing local database had migrations 001–016; migration 017 applied successfully and its ledger entry verified.
- Started only the existing lingualoop-local-postgres container; preserved its data volume and credentials.
- Repaired missing local Compose password-file configuration by reusing the existing secret mount, verifying it matched the configured database password without printing either value. Added local API loopback binding.
- API /health, /ready and STT /ready returned 200.
- Created two clearly labelled local validation activities using the actual user-provided walking/choir JPEG through the application's image normalizer and catalogue store. Teacher fixture email is local-validation-teacher@example.test, not an external invitation or real provider account.
- Existing authenticated local student started both activities through the browser UI.
- Conversation session 0729f620-cac3-453a-8c9c-c30a439f1caa: correct complete image, role, location and goals visible after reload.
- Single-response session 28bdcb8f-fffd-4e7d-a873-3babfa6c4fbd: correct complete image and persisted context after reload; no countdown. Fixed misleading timed-conversation labels and added a UI regression test.

## Pending: real microphone acceptance
The user answered “No puedo grabar ahora”. No microphone recording was started. Both validation sessions had zero submitted turns when checked. Real capture, speech-to-text, AI conversation/audio playback and the actual single-response report remain unverified with the user's voice. Do not describe prior simulated-audio tests as real microphone acceptance.

When available: record at least 30 seconds with a 3-second pause, stop manually, and verify the single-response report; then start a fresh conversation session if the original timer has expired and verify an actual coach response and playback. The local application may send recognized text to the configured OpenAI model when the user submits; raw speech transcription stays local.

## Release verification
- Built API and web successfully; all 197 web tests passed.
- Ran API non-Docker tests with Node 24 and Python 3 in a disposable Linux verification container: 772 tests, 767 passed, 5 opt-in integration/simulation tests skipped, zero failures.
- Ran all six Docker/PostgreSQL integration specs separately against disposable PostgreSQL 16 containers. Together with repeated coach/fallback regressions, the command passed all 32 tests: 17 migrations, unchanged rerun, snapshots, single-response closure/replay, empty discard, lease protection and compatible creation without activity fields.
- Updated stale test fixtures for English reports, long recordings, current OAuth invitations and migration inventory. Found and fixed omitted-activity serialization: creation now persists conversation defaults rather than SQL NULL.
- Verified POSIX key permissions and symlinks in Linux without weakening security checks for Windows. Only synthetic test credentials were used.
- The publishing workflow is unchanged. Main push builds API/web GHCR images; server deployment and migration 017 remain separate explicit steps. Real microphone/model acceptance remains pending as described above.
