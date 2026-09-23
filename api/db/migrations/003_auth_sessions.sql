CREATE TABLE lingualoop_auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES lingualoop_accounts(id),
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > 0),
  revoked_at_ms BIGINT CHECK (revoked_at_ms IS NULL OR revoked_at_ms > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX lingualoop_auth_sessions_owner_expires_idx
  ON lingualoop_auth_sessions (owner_id, expires_at_ms);
