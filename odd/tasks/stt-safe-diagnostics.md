# Safe STT diagnostics and startup recovery

## Authorization and behavior
User approved logs, STT recovery, API-only rebuild/restart preserving PostgreSQL and exact deployed SQL cast/source test compatibility. No commits, publishing, migrations, paid calls or unrelated edits. Private finite diagnostic provenance; no audio/transcript/secret/arbitrary exception fields; generic HTTP/billing/cleanup preserved.60s startup;90s host transcription deadline includes startup, excludes FFmpeg. One shared lifetime replacement on later explicit request after confirmed child exit; no automatic replay; permanent application shutdown.

## Completed tasks
- [x] T1 Runtime diagnosis:30s timeout reproduced, later20–22s initialization succeeded; model/deps/protocol valid; historical errors not conclusively attributed.
- [x] T2 Logs: observed RED66pass12fail, GREEN79Node10Python/build,320diff lines. Delegated writer.
- [x] T3 Independent logs verification:79+149Node10Python/build/whitespace passed, no blockers. Delegated verifier.
- [x] T4 Recovery: observed RED102pass9fail, final112Node10Python/build,213increment lines. Delegated writer.
- [x] T5 Independent artifact verification:235Node10Python/build/whitespace/provenance passed, no blockers. Retained test fixtures excluded from image. Delegated verifier.
- [x] T6 Authorized API-only deployment and runtime verification succeeded. APIhealth/ready and frontend/api/ready200; isolated STT initialization24.286s. Database/container/volume and repo changes preserved. Delegated verifier.

## Artifact/deployment evidence
Pinned baseline135b6d54390c533f69870c7ffc37befbc93bb060 plus9diagnostic/resilience paths and exact SQL source/test hunks=11changed paths;185source inputs verified. No untracked auth/other dirty source/local dist included.
Artifact /tmp/lingualoop-stt-T5v2-kq2v3tq4/tree/api; source archive SHAacb923be454266f83539d3af36db519994f3338343d7bf53aa886f8ee59137d7.
Deployed tag lingualoop-api:stt60-acb923be4542-kq2v3tq4; image sha256:732fbd722a2d62b73827e5ddda812fa43237f798f36006629c6f5e6be47f990b; API container ea3c63c17f2a65f846f88233a4580b6636c505ec207902364bbedb3149cb5804.
Compiled/buildinfo checks confirm60s/recovery/logs/SQL and52source hashes. All four original Compose overlays/private settings preserved; API-only no-deps recreation. Old image333a4d41 retained. Receipts/override/rollback wrapper at /tmp/lingualoop-stt-T6-7wqkkece; compose-rollback.sh retained, rollback not executed.

## Limitations and next step
STT startup tested in separate network-disabled diagnostic container, not live API singleton; no transcription/audio or TTS synthesis. Three earlier probe guard false positives aborted, corrected successful probe evidence retained. Nonexistent /api/health/ready404; correct /api/ready200, no route defect. Docker-backed DB tests and authenticated browser E2E unrun. Tests not rerun inside deployed image; compiled identity checked instead. No paid calls or commits. RDD off; assess unassessable=>independent verification complete. Combined523feature diff lines plus existing SQL compatibility hunks; workload surfaced; no PR requested.
User can test localhost:5001/login. If prior recording remains uncertain, use existing Check for response once before another recording; no promise of recovery for already failed turn. Next actual user audio test verifies full STT/coach/TTS flow and may incur configured provider charges. Feature source/task changes remain uncommitted pending explicit commit request.
