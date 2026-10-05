import { randomUUID } from 'node:crypto';
import type { QueryExecutor, QueryResult } from '../auth/identity-store';
import type { CompletedOwnedTurnProjection, LanguagePracticeReportFallback } from './language-practice-report-fallback';
import { buildLanguagePracticeReportFallback } from './language-practice-report-fallback';

export interface TransactionalQueryExecutor extends QueryExecutor {
  withTransaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}

export interface LanguagePracticeReport extends LanguagePracticeReportFallback {
  sessionId: string;
  createdAt: string;
  generatedWithAi: boolean;
}

export type BeginAiReportResult =
  | { kind: 'existing'; report: LanguagePracticeReport }
  | { kind: 'no_evidence'; report: LanguagePracticeReport }
  | { kind: 'busy' }
  | {
      kind: 'claimed';
      token: string;
      turns: CompletedOwnedTurnProjection[];
      topic: string;
      level: string;
    };

export class LanguagePracticeReportStoreError extends Error {
  constructor() {
    super('Language practice report store operation failed.');
    this.name = 'LanguagePracticeReportStoreError';
  }
}

export class LanguagePracticeReportAdmissionError extends Error {
  constructor(readonly reason: 'not_found' | 'not_closed') {
    super(reason);
    this.name = 'LanguagePracticeReportAdmissionError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_SESSION_SQL = `
  SELECT status, expires_at, active_turn_lease_token, topic, level,
    expires_at <= clock_timestamp() AS elapsed
  FROM lingualoop_language_practice_sessions
  WHERE owner_id = $1::uuid AND id = $2::uuid
  FOR UPDATE
`;
const FIND_REPORT_SQL = `
  SELECT r.content, r.generated_with_ai, r.created_at
  FROM lingualoop_language_practice_reports AS r
  INNER JOIN lingualoop_language_practice_sessions AS s ON s.id = r.session_id
  WHERE s.owner_id = $1::uuid AND s.id = $2::uuid
`;
const COMPLETED_TURNS_SQL = `
  WITH recent_completed AS (
    SELECT t.sequence, t.transcript, t.spanish_correction_evidence
    FROM lingualoop_language_practice_turns AS t
    INNER JOIN lingualoop_language_practice_sessions AS s ON s.id = t.session_id
    WHERE s.owner_id = $1::uuid AND s.id = $2::uuid AND t.status = 'COMPLETED'
    ORDER BY t.sequence DESC
    LIMIT 256
  )
  SELECT sequence, transcript, spanish_correction_evidence
  FROM recent_completed
  ORDER BY sequence ASC
`;
const INSERT_REPORT_SQL = `
  INSERT INTO lingualoop_language_practice_reports (session_id, content, generated_with_ai)
  VALUES ($1::uuid, $2::jsonb, FALSE)
  ON CONFLICT (session_id) DO NOTHING
`;
const INSERT_AI_REPORT_SQL = `
  INSERT INTO lingualoop_language_practice_reports (session_id, content, generated_with_ai)
  VALUES ($1::uuid, $2::jsonb, TRUE)
  ON CONFLICT (session_id) DO NOTHING
`;
const CLAIM_REPORT_SQL = `
  INSERT INTO lingualoop_language_practice_report_claims (session_id, claim_token, lease_expires_at)
  VALUES ($1::uuid, $2::uuid, clock_timestamp() + interval '2 minutes')
  ON CONFLICT (session_id) DO UPDATE
    SET claim_token = EXCLUDED.claim_token, lease_expires_at = EXCLUDED.lease_expires_at
    WHERE lingualoop_language_practice_report_claims.lease_expires_at <= clock_timestamp()
  RETURNING claim_token
`;
const LOCK_VALID_CLAIM_SQL = `
  SELECT c.claim_token
  FROM lingualoop_language_practice_report_claims AS c
  INNER JOIN lingualoop_language_practice_sessions AS s ON s.id = c.session_id
  WHERE s.owner_id = $1::uuid AND s.id = $2::uuid AND c.claim_token = $3::uuid
    AND c.lease_expires_at > clock_timestamp()
  FOR UPDATE OF c
`;
const RELEASE_CLAIM_SQL = `
  DELETE FROM lingualoop_language_practice_report_claims AS c
  USING lingualoop_language_practice_sessions AS s
  WHERE s.id = c.session_id AND s.owner_id = $1::uuid AND c.session_id = $2::uuid
    AND c.claim_token = $3::uuid
  RETURNING c.session_id
`;
const DELETE_CLAIM_SQL = `
  DELETE FROM lingualoop_language_practice_report_claims
  WHERE session_id = $1::uuid AND claim_token = $2::uuid
`;
const MARK_EXPIRED_SQL = `
  UPDATE lingualoop_language_practice_sessions SET status = 'EXPIRED'
  WHERE id = $1::uuid AND owner_id = $2::uuid AND status = 'ACTIVE' AND expires_at <= clock_timestamp()
`;
const FAIL_LEASE_SQL = `
  UPDATE lingualoop_language_practice_turns
  SET status = 'FAILED', failure_code = 'LANGUAGE_PRACTICE_SESSION_CLOSED', lease_token = NULL
  WHERE session_id = $1::uuid AND status = 'PROCESSING' AND lease_token = $2::uuid
`;
const CLEAR_LEASE_SQL = `
  UPDATE lingualoop_language_practice_sessions
  SET active_turn_lease_token = NULL, active_turn_lease_expires_at = NULL
  WHERE id = $1::uuid AND owner_id = $2::uuid AND active_turn_lease_token = $3::uuid
`;

function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new LanguagePracticeReportStoreError();
}

function rows(result: QueryResult, minimum: number, maximum: number): unknown[] {
  if (!result || !Array.isArray(result.rows) || result.rows.length < minimum || result.rows.length > maximum) {
    throw new LanguagePracticeReportStoreError();
  }
  return result.rows;
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) throw new LanguagePracticeReportStoreError();
  return date.toISOString();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LanguagePracticeReportStoreError();
  return value as Record<string, unknown>;
}

function report(rowValue: unknown, sessionId: string): LanguagePracticeReport {
  const row = object(rowValue);
  if (typeof row.generated_with_ai !== 'boolean') throw new LanguagePracticeReportStoreError();
  const content = object(row.content);
  if (Object.keys(content).sort().join(',') !== 'corrections,recommendations,strengths,summary') {
    throw new LanguagePracticeReportStoreError();
  }
  if (typeof content.summary !== 'string' || !content.summary.trim() || content.summary.length > 400 ||
      !Array.isArray(content.corrections) || content.corrections.length > 20 ||
      !Array.isArray(content.strengths) || content.strengths.length > 3 ||
      !Array.isArray(content.recommendations) || content.recommendations.length > 3 ||
      content.strengths.some((item) => typeof item !== 'string' || !item.trim() || item.length > 400) ||
      content.recommendations.some((item) => typeof item !== 'string' || !item.trim() || item.length > 400)) {
    throw new LanguagePracticeReportStoreError();
  }
  const corrections = content.corrections.map((item) => {
    const correction = object(item);
    if (Object.keys(correction).sort().join(',') !== 'correctedPhrase,explanation,original,sequence' ||
        !Number.isSafeInteger(correction.sequence) || (correction.sequence as number) < 1 ||
        typeof correction.original !== 'string' || !correction.original.trim() || correction.original.length > 500 ||
        typeof correction.correctedPhrase !== 'string' || !correction.correctedPhrase.trim() || correction.correctedPhrase.length > 300 ||
        typeof correction.explanation !== 'string' || !correction.explanation.trim() || correction.explanation.length > 280) {
      throw new LanguagePracticeReportStoreError();
    }
    return {
      sequence: correction.sequence as number,
      original: correction.original,
      correctedPhrase: correction.correctedPhrase,
      explanation: correction.explanation,
    };
  });
  if (row.created_at === undefined) throw new LanguagePracticeReportStoreError();
  return {
    sessionId,
    summary: content.summary,
    corrections,
    strengths: [...content.strengths] as string[],
    recommendations: [...content.recommendations] as string[],
    createdAt: timestamp(row.created_at),
    generatedWithAi: row.generated_with_ai,
  };
}

function completedTurn(value: unknown): CompletedOwnedTurnProjection {
  const row = object(value);
  if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1 ||
      typeof row.transcript !== 'string' ||
      (row.spanish_correction_evidence !== null && typeof row.spanish_correction_evidence !== 'string')) {
    throw new LanguagePracticeReportStoreError();
  }
  return {
    sequence: row.sequence as number,
    transcript: row.transcript,
    spanishCorrectionEvidence: row.spanish_correction_evidence as string | null,
  };
}

/** Creates a single immutable deterministic report per owned, closed practice session. */
export class LanguagePracticeReportStore {
  constructor(private readonly executor: TransactionalQueryExecutor) {
    if (!executor || typeof executor.withTransaction !== 'function') throw new TypeError('A transactional query executor is required.');
  }

  async beginAiReport(ownerId: string, sessionId: string): Promise<BeginAiReportResult> {
    uuid(ownerId);
    uuid(sessionId);
    try {
      const result = await this.executor.withTransaction(async (tx) => {
        const session = rows(await tx.query(LOCK_SESSION_SQL, [ownerId, sessionId]), 0, 1)[0];
        if (!session) return { admission: 'not_found' as const };
        const existing = rows(await tx.query(FIND_REPORT_SQL, [ownerId, sessionId]), 0, 1);
        if (existing.length) return { value: { kind: 'existing' as const, report: report(existing[0], sessionId) } };

        const sessionRow = object(session);
        if (sessionRow.status !== 'COMPLETED' && sessionRow.status !== 'EXPIRED' &&
            !(sessionRow.status === 'ACTIVE' && sessionRow.elapsed === true)) {
          return { admission: 'not_closed' as const };
        }
        if (sessionRow.status === 'ACTIVE') await tx.query(MARK_EXPIRED_SQL, [sessionId, ownerId]);
        const activeLease = sessionRow.active_turn_lease_token;
        if (activeLease !== null) {
          uuid(activeLease);
          await tx.query(FAIL_LEASE_SQL, [sessionId, activeLease]);
          await tx.query(CLEAR_LEASE_SQL, [sessionId, ownerId, activeLease]);
        }

        const turnRows = rows(await tx.query(COMPLETED_TURNS_SQL, [ownerId, sessionId]), 0, 256);
        const turns = turnRows.map(completedTurn);
        if (turns.length === 0) {
          await tx.query(INSERT_REPORT_SQL, [sessionId, JSON.stringify(buildLanguagePracticeReportFallback(turns))]);
          const stored = rows(await tx.query(FIND_REPORT_SQL, [ownerId, sessionId]), 1, 1)[0];
          return { value: { kind: 'no_evidence' as const, report: report(stored, sessionId) } };
        }

        const token = randomUUID();
        const claim = rows(await tx.query(CLAIM_REPORT_SQL, [sessionId, token]), 0, 1);
        if (claim.length === 0) return { value: { kind: 'busy' as const } };
        const claimRow = object(claim[0]);
        if (claimRow.claim_token !== token || typeof sessionRow.topic !== 'string' || typeof sessionRow.level !== 'string') {
          throw new LanguagePracticeReportStoreError();
        }
        return { value: { kind: 'claimed' as const, token, turns, topic: sessionRow.topic, level: sessionRow.level } };
      });
      if ('admission' in result && result.admission) throw new LanguagePracticeReportAdmissionError(result.admission);
      if (!('value' in result)) throw new LanguagePracticeReportStoreError();
      return result.value;
    } catch (error) {
      if (error instanceof LanguagePracticeReportAdmissionError) throw error;
      throw new LanguagePracticeReportStoreError();
    }
  }

  async releaseAiReport(ownerId: string, sessionId: string, token: string): Promise<boolean> {
    uuid(ownerId);
    uuid(sessionId);
    uuid(token);
    try {
      return rows(await this.executor.query(RELEASE_CLAIM_SQL, [ownerId, sessionId, token]), 0, 1).length === 1;
    } catch {
      throw new LanguagePracticeReportStoreError();
    }
  }

  async finalizeAiReport(
    ownerId: string,
    sessionId: string,
    token: string,
    content: LanguagePracticeReportFallback,
  ): Promise<LanguagePracticeReport | null> {
    uuid(ownerId);
    uuid(sessionId);
    uuid(token);
    // Reuse the durable report parser as the exact content/size validator before any write.
    report({ content, generated_with_ai: true, created_at: new Date() }, sessionId);
    try {
      const result = await this.executor.withTransaction(async (tx) => {
        const claim = rows(await tx.query(LOCK_VALID_CLAIM_SQL, [ownerId, sessionId, token]), 0, 1);
        if (claim.length === 0) return { value: null };
        await tx.query(INSERT_AI_REPORT_SQL, [sessionId, JSON.stringify(content)]);
        await tx.query(DELETE_CLAIM_SQL, [sessionId, token]);
        const stored = rows(await tx.query(FIND_REPORT_SQL, [ownerId, sessionId]), 1, 1)[0];
        return { value: report(stored, sessionId) };
      });
      if (!('value' in result)) throw new LanguagePracticeReportStoreError();
      return result.value;
    } catch {
      throw new LanguagePracticeReportStoreError();
    }
  }

  async getOrCreate(ownerId: string, sessionId: string): Promise<LanguagePracticeReport> {
    uuid(ownerId);
    uuid(sessionId);
    try {
      const result = await this.executor.withTransaction(async (tx) => {
        const session = rows(await tx.query(LOCK_SESSION_SQL, [ownerId, sessionId]), 0, 1)[0];
        if (!session) return { admission: 'not_found' as const };
        const existing = rows(await tx.query(FIND_REPORT_SQL, [ownerId, sessionId]), 0, 1);
        if (existing.length) return { value: report(existing[0], sessionId) };

        const sessionRow = object(session);
        if (sessionRow.status !== 'COMPLETED' && sessionRow.status !== 'EXPIRED' &&
            !(sessionRow.status === 'ACTIVE' && sessionRow.elapsed === true)) {
          return { admission: 'not_closed' as const };
        }
        if (sessionRow.status === 'ACTIVE') await tx.query(MARK_EXPIRED_SQL, [sessionId, ownerId]);

        const activeLease = sessionRow.active_turn_lease_token;
        if (activeLease !== null) {
          uuid(activeLease);
          await tx.query(FAIL_LEASE_SQL, [sessionId, activeLease]);
          await tx.query(CLEAR_LEASE_SQL, [sessionId, ownerId, activeLease]);
        }

        const turnRows = rows(await tx.query(COMPLETED_TURNS_SQL, [ownerId, sessionId]), 0, 256);
        const fallback = buildLanguagePracticeReportFallback(turnRows.map(completedTurn));
        await tx.query(INSERT_REPORT_SQL, [sessionId, JSON.stringify(fallback)]);
        const stored = rows(await tx.query(FIND_REPORT_SQL, [ownerId, sessionId]), 1, 1)[0];
        return { value: report(stored, sessionId) };
      });
      if ('admission' in result && result.admission) {
        throw new LanguagePracticeReportAdmissionError(result.admission);
      }
      if (!('value' in result)) throw new LanguagePracticeReportStoreError();
      return result.value;
    } catch (error) {
      if (error instanceof LanguagePracticeReportAdmissionError) throw error;
      throw new LanguagePracticeReportStoreError();
    }
  }
}
