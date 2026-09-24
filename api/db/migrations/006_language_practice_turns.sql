ALTER TABLE lingualoop_language_practice_sessions
  ADD COLUMN active_turn_lease_token UUID,
  ADD COLUMN active_turn_lease_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT lingualoop_language_practice_sessions_lease_check CHECK (
    (active_turn_lease_token IS NULL) = (active_turn_lease_expires_at IS NULL)
  );

CREATE TABLE lingualoop_language_practice_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES lingualoop_language_practice_sessions(id) ON DELETE CASCADE,
  client_turn_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  lease_token UUID,
  transcript TEXT,
  assistant_response TEXT,
  failure_code VARCHAR(64),
  spanish_correction_evidence TEXT CHECK (char_length(spanish_correction_evidence) <= 2000),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lingualoop_language_practice_turns_completed_check CHECK (
    status <> 'COMPLETED' OR
      (transcript IS NOT NULL AND assistant_response IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT lingualoop_language_practice_turns_session_client_unique UNIQUE (session_id, client_turn_id),
  CONSTRAINT lingualoop_language_practice_turns_session_sequence_unique UNIQUE (session_id, sequence)
);

CREATE INDEX lingualoop_language_practice_turns_session_status_idx
  ON lingualoop_language_practice_turns (session_id, status);
CREATE INDEX lingualoop_language_practice_sessions_lease_expiry_idx
  ON lingualoop_language_practice_sessions (active_turn_lease_expires_at)
  WHERE active_turn_lease_token IS NOT NULL;

CREATE FUNCTION lingualoop_reserve_language_practice_turn(
  requested_owner UUID,
  requested_session UUID,
  requested_client_turn UUID
) RETURNS TABLE (
  outcome TEXT,
  turn_id UUID,
  client_turn_id UUID,
  turn_sequence INTEGER,
  turn_status TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  transcript TEXT,
  assistant_response TEXT,
  failure_code TEXT,
  spanish_correction_evidence TEXT,
  completed_at TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
DECLARE
  current_session lingualoop_language_practice_sessions%ROWTYPE;
  existing_turn lingualoop_language_practice_turns%ROWTYPE;
  generated_lease UUID;
  next_sequence INTEGER;
  database_now TIMESTAMPTZ;
BEGIN
  SELECT s.* INTO current_session
  FROM lingualoop_language_practice_sessions AS s
  WHERE s.id = requested_session AND s.owner_id = requested_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::UUID, NULL::INTEGER,
      NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT t.* INTO existing_turn
  FROM lingualoop_language_practice_turns AS t
  WHERE t.session_id = requested_session AND t.client_turn_id = requested_client_turn;
  IF FOUND THEN
    RETURN QUERY SELECT 'replay'::TEXT, existing_turn.id, existing_turn.client_turn_id,
      existing_turn.sequence, existing_turn.status::TEXT, existing_turn.lease_token,
      CASE WHEN existing_turn.lease_token = current_session.active_turn_lease_token
        THEN current_session.active_turn_lease_expires_at ELSE NULL END,
      existing_turn.transcript, existing_turn.assistant_response,
      existing_turn.failure_code::TEXT, existing_turn.spanish_correction_evidence, existing_turn.completed_at;
    RETURN;
  END IF;

  database_now := clock_timestamp();
  IF current_session.status <> 'ACTIVE' OR current_session.expires_at <= database_now THEN
    RETURN QUERY SELECT 'session_expired'::TEXT, NULL::UUID, NULL::UUID, NULL::INTEGER,
      NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF current_session.active_turn_lease_token IS NOT NULL THEN
    IF current_session.active_turn_lease_expires_at > database_now THEN
      RETURN QUERY SELECT 'turn_in_progress'::TEXT, NULL::UUID, NULL::UUID, NULL::INTEGER,
        NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    UPDATE lingualoop_language_practice_turns AS t
      SET status = 'FAILED', failure_code = 'LANGUAGE_PRACTICE_LEASE_EXPIRED',
          lease_token = NULL
      WHERE t.session_id = requested_session AND t.status = 'PROCESSING'
        AND t.lease_token = current_session.active_turn_lease_token;
    UPDATE lingualoop_language_practice_sessions AS s
      SET active_turn_lease_token = NULL, active_turn_lease_expires_at = NULL
      WHERE s.id = requested_session AND s.owner_id = requested_owner
        AND s.active_turn_lease_token = current_session.active_turn_lease_token;
  END IF;

  generated_lease := gen_random_uuid();
  UPDATE lingualoop_language_practice_sessions AS s
    SET active_turn_lease_token = generated_lease,
        active_turn_lease_expires_at = database_now + INTERVAL '30 seconds'
    WHERE s.id = requested_session AND s.owner_id = requested_owner;
  SELECT COALESCE(MAX(t.sequence), 0) + 1 INTO next_sequence
    FROM lingualoop_language_practice_turns AS t WHERE t.session_id = requested_session;
  INSERT INTO lingualoop_language_practice_turns
    (session_id, client_turn_id, sequence, lease_token)
  VALUES (requested_session, requested_client_turn, next_sequence, generated_lease)
  RETURNING id, lingualoop_language_practice_turns.client_turn_id,
    lingualoop_language_practice_turns.sequence, lingualoop_language_practice_turns.status,
    lingualoop_language_practice_turns.lease_token
  INTO existing_turn.id, existing_turn.client_turn_id, existing_turn.sequence,
    existing_turn.status, existing_turn.lease_token;

  RETURN QUERY SELECT 'admitted'::TEXT, existing_turn.id, existing_turn.client_turn_id,
    existing_turn.sequence, existing_turn.status::TEXT, existing_turn.lease_token,
    database_now + INTERVAL '30 seconds', NULL::TEXT, NULL::TEXT, NULL::TEXT,
    NULL::TEXT, NULL::TIMESTAMPTZ;
END;
$$;

CREATE FUNCTION lingualoop_complete_language_practice_turn(
  requested_owner UUID,
  requested_session UUID,
  requested_turn UUID,
  requested_lease UUID,
  requested_transcript TEXT,
  requested_assistant_response TEXT,
  requested_spanish_correction_evidence TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  current_session lingualoop_language_practice_sessions%ROWTYPE;
  completed_at_value TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT s.* INTO current_session
  FROM lingualoop_language_practice_sessions AS s
  WHERE s.id = requested_session AND s.owner_id = requested_owner
    AND s.active_turn_lease_token = requested_lease
  FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  UPDATE lingualoop_language_practice_turns AS t
    SET status = 'COMPLETED', transcript = requested_transcript,
        assistant_response = requested_assistant_response,
        spanish_correction_evidence = LEFT(requested_spanish_correction_evidence, 2000),
        completed_at = completed_at_value, lease_token = NULL
    WHERE t.id = requested_turn AND t.session_id = requested_session
      AND t.status = 'PROCESSING' AND t.lease_token = requested_lease;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  UPDATE lingualoop_language_practice_sessions AS s
    SET active_turn_lease_token = NULL, active_turn_lease_expires_at = NULL
    WHERE s.id = requested_session AND s.owner_id = requested_owner
      AND s.active_turn_lease_token = requested_lease;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION lingualoop_fail_language_practice_turn(
  requested_owner UUID,
  requested_session UUID,
  requested_turn UUID,
  requested_lease UUID
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  current_session lingualoop_language_practice_sessions%ROWTYPE;
BEGIN
  SELECT s.* INTO current_session
  FROM lingualoop_language_practice_sessions AS s
  WHERE s.id = requested_session AND s.owner_id = requested_owner
    AND s.active_turn_lease_token = requested_lease
  FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  UPDATE lingualoop_language_practice_turns AS t
    SET status = 'FAILED', failure_code = 'LANGUAGE_PRACTICE_UNAVAILABLE', lease_token = NULL
    WHERE t.id = requested_turn AND t.session_id = requested_session
      AND t.status = 'PROCESSING' AND t.lease_token = requested_lease;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  UPDATE lingualoop_language_practice_sessions AS s
    SET active_turn_lease_token = NULL, active_turn_lease_expires_at = NULL
    WHERE s.id = requested_session AND s.owner_id = requested_owner
      AND s.active_turn_lease_token = requested_lease;
  RETURN FOUND;
END;
$$;
