ALTER TABLE lingualoop_practices ADD COLUMN activity JSONB NOT NULL DEFAULT '{"mode":"conversation","aiRole":"","location":""}'::jsonb CHECK (jsonb_typeof(activity) = 'object' AND activity->>'mode' IN ('conversation','single-response'));
ALTER TABLE lingualoop_language_practice_sessions ADD COLUMN activity_snapshot JSONB NOT NULL DEFAULT '{"mode":"conversation","aiRole":"","location":""}'::jsonb CHECK (jsonb_typeof(activity_snapshot) = 'object' AND activity_snapshot->>'mode' IN ('conversation','single-response'));

CREATE OR REPLACE FUNCTION lingualoop_reserve_language_practice_turn(
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

  IF current_session.activity_snapshot->>'mode' = 'single-response' AND EXISTS (
    SELECT 1 FROM lingualoop_language_practice_turns AS t WHERE t.session_id = requested_session AND t.status = 'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'session_expired'::TEXT, NULL::UUID, NULL::UUID, NULL::INTEGER,
      NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  database_now := clock_timestamp();
  IF current_session.status <> 'ACTIVE' OR current_session.expires_at <= database_now - INTERVAL '12 minutes' THEN
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
        active_turn_lease_expires_at = database_now + INTERVAL '20 minutes'
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
    database_now + INTERVAL '20 minutes', NULL::TEXT, NULL::TEXT, NULL::TEXT,
    NULL::TEXT, NULL::TIMESTAMPTZ;
END;
$$;

CREATE OR REPLACE FUNCTION lingualoop_complete_language_practice_turn(
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
    SET active_turn_lease_token = NULL, active_turn_lease_expires_at = NULL,
        status = CASE WHEN s.activity_snapshot->>'mode' = 'single-response' THEN 'COMPLETED' ELSE s.status END,
        completed_at = CASE WHEN s.activity_snapshot->>'mode' = 'single-response' THEN completed_at_value ELSE s.completed_at END
    WHERE s.id = requested_session AND s.owner_id = requested_owner
      AND s.active_turn_lease_token = requested_lease;
  RETURN FOUND;
END;
$$;


ALTER TABLE lingualoop_language_practice_reports ADD COLUMN report_language TEXT NOT NULL DEFAULT 'legacy' CHECK (report_language IN ('legacy','en'));
ALTER TABLE lingualoop_language_practice_reports ADD COLUMN legacy_content JSONB;
