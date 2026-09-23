CREATE TABLE lingualoop_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer VARCHAR(64) NOT NULL,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lingualoop_accounts_identity_unique UNIQUE (issuer, subject),
  CONSTRAINT lingualoop_accounts_google_issuer CHECK (issuer = 'google'),
  CONSTRAINT lingualoop_accounts_subject_length CHECK (octet_length(subject) BETWEEN 1 AND 512)
);
