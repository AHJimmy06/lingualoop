CREATE TABLE lingualoop_language_practice_report_claims (
  session_id UUID PRIMARY KEY
    REFERENCES lingualoop_language_practice_sessions(id) ON DELETE CASCADE,
  claim_token UUID NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL
);
