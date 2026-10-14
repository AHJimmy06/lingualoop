-- Apply only after the operator-confirmed prototype data reset; never seed identities here.
-- Preserve identity columns used by the already-applied refresh rotation function.
ALTER TABLE lingualoop_accounts
  DROP CONSTRAINT lingualoop_accounts_google_issuer,
  ADD CONSTRAINT lingualoop_accounts_local_identity CHECK (issuer = 'local' AND subject = id::text),
  ADD COLUMN name VARCHAR(120) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  ADD COLUMN email VARCHAR(254) NOT NULL UNIQUE
    CHECK (email = lower(btrim(email)) AND octet_length(email) BETWEEN 3 AND 254
      AND email ~ '^[!-~]+@[!-~]+$'),
  ADD COLUMN password_hash TEXT NOT NULL
    CHECK (password_hash ~ '^scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{128}$'),
  ADD COLUMN role VARCHAR(7) NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX lingualoop_one_admin_account
  ON lingualoop_accounts (role) WHERE role = 'admin';

-- Ordered parameters use [{id, requirement}]; authoring validation belongs to the API.
CREATE TABLE lingualoop_practices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES lingualoop_accounts(id) ON DELETE RESTRICT,
  title VARCHAR(120) NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  topic VARCHAR(64) NOT NULL CHECK (topic IN ('travel', 'work', 'studies', 'everyday-conversation')),
  level VARCHAR(2) NOT NULL CHECK (level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes IN (5, 10, 15)),
  parameters JSONB NOT NULL CHECK (jsonb_typeof(parameters) = 'array'
    AND jsonb_array_length(parameters) BETWEEN 1 AND 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lingualoop_practices_teacher_created_idx ON lingualoop_practices (teacher_id, created_at);

-- Existing session setup columns are already a snapshot; add the custom source and ordered requirements.
ALTER TABLE lingualoop_language_practice_sessions
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN practice_id UUID REFERENCES lingualoop_practices(id) ON DELETE RESTRICT,
  ADD COLUMN parameters_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(parameters_snapshot) = 'array' AND jsonb_array_length(parameters_snapshot) <= 20);

-- Separate from existing report content, whose legacy exact-key parser remains unchanged in this unit.
ALTER TABLE lingualoop_language_practice_reports
  ADD COLUMN parameter_coverage JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(parameter_coverage) = 'array' AND jsonb_array_length(parameter_coverage) <= 20);
