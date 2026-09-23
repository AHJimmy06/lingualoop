CREATE TABLE lingualoop_oauth_states (
  state_hash VARCHAR(64) PRIMARY KEY,
  expires_at_ms BIGINT NOT NULL,
  provider VARCHAR(16) NOT NULL,
  CONSTRAINT lingualoop_oauth_states_hash_sha256 CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT lingualoop_oauth_states_expiry_positive CHECK (expires_at_ms > 0),
  CONSTRAINT lingualoop_oauth_states_google_provider CHECK (provider = 'google')
);
