ALTER TABLE lingualoop_oauth_states
  DROP CONSTRAINT lingualoop_oauth_states_google_provider,
  ADD CONSTRAINT lingualoop_oauth_states_provider
    CHECK (provider IN ('google', 'microsoft'));

CREATE TABLE lingualoop_external_identities (
  account_id UUID NOT NULL REFERENCES lingualoop_accounts(id) ON DELETE CASCADE,
  issuer VARCHAR(16) NOT NULL CHECK (issuer IN ('google', 'microsoft')),
  subject TEXT NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 512),
  email VARCHAR(254) NOT NULL CHECK (email = lower(btrim(email)) AND octet_length(email) BETWEEN 3 AND 254),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  UNIQUE (account_id, issuer)
);
