CREATE TABLE lingualoop_language_practice_reports (
  session_id UUID PRIMARY KEY
    REFERENCES lingualoop_language_practice_sessions(id) ON DELETE CASCADE,
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  generated_with_ai BOOLEAN NOT NULL DEFAULT FALSE CHECK (generated_with_ai = FALSE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
