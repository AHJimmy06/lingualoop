ALTER TABLE lingualoop_auth_sessions
  ADD COLUMN current_refresh_hash CHAR(64)
  CHECK (current_refresh_hash IS NULL OR current_refresh_hash ~ '^[0-9a-f]{64}$');

CREATE TABLE lingualoop_spent_refresh_hashes (
  token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  session_id UUID NOT NULL REFERENCES lingualoop_auth_sessions(id) ON DELETE CASCADE,
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > 0)
);

CREATE INDEX lingualoop_spent_refresh_hashes_expiry_idx
  ON lingualoop_spent_refresh_hashes (expires_at_ms);

CREATE FUNCTION lingualoop_rotate_refresh(
  p_session_id UUID,
  p_presented_hash TEXT,
  p_next_hash TEXT,
  p_now_ms BIGINT
) RETURNS TABLE (
  status TEXT,
  owner_id UUID,
  issuer TEXT,
  subject TEXT,
  expires_at_ms BIGINT
) LANGUAGE plpgsql AS $$
DECLARE
  session_row lingualoop_auth_sessions%ROWTYPE;
BEGIN
  SELECT s.* INTO session_row
  FROM lingualoop_auth_sessions AS s
  WHERE s.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR session_row.revoked_at_ms IS NOT NULL OR session_row.expires_at_ms <= p_now_ms THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  IF session_row.current_refresh_hash = p_presented_hash THEN
    UPDATE lingualoop_auth_sessions
    SET current_refresh_hash = p_next_hash
    WHERE id = p_session_id;
    INSERT INTO lingualoop_spent_refresh_hashes (token_hash, session_id, expires_at_ms)
    VALUES (p_presented_hash, p_session_id, session_row.expires_at_ms);
    RETURN QUERY
      SELECT 'rotated'::TEXT, session_row.owner_id, a.issuer::TEXT, a.subject::TEXT, session_row.expires_at_ms
      FROM lingualoop_accounts AS a WHERE a.id = session_row.owner_id;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM lingualoop_spent_refresh_hashes AS h
    WHERE h.token_hash = p_presented_hash AND h.session_id = p_session_id
  ) THEN
    UPDATE lingualoop_auth_sessions SET revoked_at_ms = p_now_ms
    WHERE id = p_session_id;
    RETURN QUERY SELECT 'replay'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BIGINT;
END;
$$;
