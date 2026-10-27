# Session activity image contract

GET /language-practice/sessions/:sessionId/image (browser prefix /api).
Requires the existing verified student bearer and role guards.
- 200: bounded JPEG bytes for the practice linked to the owned session; Content-Type image/jpeg, Content-Length, private/no-store and nosniff.
- 204: owned session has no activity image (built-in or teacher activity without image).
- 400: invalid UUID; 401/403: existing authentication/role policy; 404: missing or foreign session; 503: storage unavailable/invalid bytes.
The client cannot choose a practice id. The persisted session link is used on every load. No schema migration is needed; existing sessions retain practice_id. Images remain the existing catalogue image, not a separate immutable image snapshot.

Live view displays full image with object-contain and a full-size link. Loading/errors never show a misleading default. Only 204 selects the existing generic scene. No image is sent to inference providers.
