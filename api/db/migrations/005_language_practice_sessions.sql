CREATE TABLE lingualoop_language_practice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES lingualoop_accounts(id) ON DELETE CASCADE,
  level VARCHAR(2) NOT NULL CHECK (level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  topic VARCHAR(64) NOT NULL CHECK (topic IN ('travel', 'work', 'studies', 'everyday-conversation')),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes IN (5, 10, 15)),
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'EXPIRED', 'COMPLETED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX lingualoop_language_practice_sessions_owner_expiry_idx
  ON lingualoop_language_practice_sessions (owner_id, expires_at);
