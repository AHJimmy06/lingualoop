-- Nullable themes preserve historical category semantics; no title backfill.
ALTER TABLE lingualoop_practices
  ADD COLUMN conversation_theme VARCHAR(120)
    CHECK (conversation_theme IS NULL OR char_length(btrim(conversation_theme)) BETWEEN 1 AND 120);

ALTER TABLE lingualoop_language_practice_sessions
  ADD COLUMN conversation_theme_snapshot VARCHAR(120)
    CHECK (conversation_theme_snapshot IS NULL OR char_length(btrim(conversation_theme_snapshot)) BETWEEN 1 AND 120);

-- Covers stay in the existing database; the application stores normalized JPEG only.
CREATE TABLE lingualoop_practice_images (
  practice_id UUID PRIMARY KEY REFERENCES lingualoop_practices(id) ON DELETE CASCADE,
  bytes BYTEA NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 2097152),
  mime TEXT NOT NULL CHECK (mime = 'image/jpeg')
);
