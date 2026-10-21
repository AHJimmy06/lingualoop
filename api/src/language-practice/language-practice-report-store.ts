import { randomUUID } from 'node:crypto';
import { parsePracticeDifficulty, type PracticeDifficulty } from './language-practice-session-store';
import { practiceTopicLabel } from './practice-topic-labels';
import { parsePracticeParameters, type PracticeParameter } from './practice-catalogue';
import { unassessedCoverage, validateParameterCoverage, type ParameterCoverage } from './parameter-coverage';
import type { QueryExecutor, QueryResult } from '../auth/identity-store';
import type { CompletedOwnedTurnProjection, LanguagePracticeReportFallback } from './language-practice-report-fallback';
import { buildLanguagePracticeReportFallback } from './language-practice-report-fallback';
import { parseReportLearningSupport, type ReportLearningSupport, type ReportLearningSupportInput } from './report-learning-support';

export interface TransactionalQueryExecutor extends QueryExecutor {
  withTransaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}

export interface LanguagePracticeReport extends LanguagePracticeReportFallback {
  sessionId: string;
  createdAt: string;
  generatedWithAi: boolean;
  parameterCoverage: ParameterCoverage[];
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
      difficulty: PracticeDifficulty | null;
      parameters: PracticeParameter[];
    };

export type BeginLearningSupportResult =
  | { kind: 'existing'; support: ReportLearningSupport }
  | { kind: 'busy' }
  | { kind: 'claimed'; token: string; input: ReportLearningSupportInput };

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
  SELECT status, expires_at, active_turn_lease_token, topic, level, difficulty, parameters_snapshot, conversation_theme_snapshot,
    expires_at <= clock_timestamp() AS elapsed
  FROM lingualoop_language_practice_sessions
  WHERE owner_id = $1::uuid AND id = $2::uuid
  FOR UPDATE
`;
const FIND_REPORT_SQL = `
  SELECT r.content, r.generated_with_ai, r.created_at, r.parameter_coverage, s.parameters_snapshot,
    ARRAY(SELECT t.sequence FROM lingualoop_language_practice_turns AS t
      WHERE t.session_id = s.id AND t.status = 'COMPLETED' AND btrim(t.transcript) <> '') AS student_sequences
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
  INSERT INTO lingualoop_language_practice_reports (session_id, content, generated_with_ai, parameter_coverage)
  VALUES ($1::uuid, $2::jsonb, FALSE, $3::jsonb)
  ON CONFLICT (session_id) DO NOTHING
`;
const INSERT_AI_REPORT_SQL = `
  INSERT INTO lingualoop_language_practice_reports (session_id, content, generated_with_ai, parameter_coverage)
  VALUES ($1::uuid, $2::jsonb, TRUE, $3::jsonb)
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
  SELECT c.claim_token, s.parameters_snapshot
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
  if (Object.keys(content).filter(key => key !== 'learningSupport').sort().join(',') !== 'corrections,recommendations,strengths,summary') {
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
  const parameters = parsePracticeParameters(row.parameters_snapshot ?? []);
  // Historical reports are returned without a new paid request. Empty legacy coverage is unassessed.
  const coverage = row.parameter_coverage ?? [];
  const parameterCoverage = Array.isArray(coverage) && coverage.length === 0
    ? unassessedCoverage(parameters) : validateParameterCoverage(coverage, parameters,
      new Set(Array.isArray(row.student_sequences) ? row.student_sequences as number[] : []));
  return {
    sessionId,
    parameterCoverage,
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

  /** Private cache read only. No provider construction, report generation or claim acquisition. */
  async getCachedLearningSupport(ownerId: string, sessionId: string): Promise<ReportLearningSupport | null> {
    uuid(ownerId); uuid(sessionId);
    return this.executor.withTransaction(async tx => {
      const session = rows(await tx.query(LOCK_SESSION_SQL, [ownerId, sessionId]), 0, 1)[0];
      if (!session) throw new LanguagePracticeReportAdmissionError('not_found');
      const existing = rows(await tx.query(FIND_REPORT_SQL, [ownerId, sessionId]), 0, 1)[0];
      if (!existing || !Object.hasOwn(object(object(existing).content), 'learningSupport')) return null;
      const turns = rows(await tx.query(COMPLETED_TURNS_SQL, [ownerId, sessionId]), 0, 256).map(completedTurn);
      return parseReportLearningSupport(object(object(existing).content).learningSupport, { report: report(existing, sessionId), turns });
    });
  }

  /** Reuse the durable report lease so concurrent processes cannot bill the same enrichment twice. */
  async beginLearningSupport(ownerId: string, sessionId: string): Promise<BeginLearningSupportResult> {
    uuid(ownerId); uuid(sessionId);
    return this.executor.withTransaction(async tx => {
      const session = rows(await tx.query(LOCK_SESSION_SQL, [ownerId, sessionId]), 0, 1)[0];
      if (!session) throw new LanguagePracticeReportAdmissionError('not_found');
      const state = object(session);
      if (state.status !== 'COMPLETED' && state.status !== 'EXPIRED' && !(state.status === 'ACTIVE' && state.elapsed === true)) {
        throw new LanguagePracticeReportAdmissionError('not_closed');
      }
      const existing = rows(await tx.query(FIND_REPORT_SQL, [ownerId, sessionId]), 0, 1)[0];
      if (!existing) throw new LanguagePracticeReportAdmissionError('not_closed');
      const turns = rows(await tx.query(COMPLETED_TURNS_SQL, [ownerId, sessionId]), 0, 256).map(completedTurn);
      const input = { report: report(existing, sessionId), turns };
      const content = object(object(existing).content);
      if (Object.hasOwn(content, 'learningSupport')) return { kind: 'existing', support: parseReportLearningSupport(content.learningSupport, input) };
      const token = randomUUID();
      const claim = rows(await tx.query(CLAIM_REPORT_SQL, [sessionId, token]), 0, 1);
      if (!claim.length) return { kind: 'busy' };
      if (object(claim[0]).claim_token !== token) throw new LanguagePracticeReportStoreError();
      return { kind: 'claimed', token, input };
    });
  }

  async finalizeLearningSupport(ownerId: string, sessionId: string, token: string, value: ReportLearningSupport): Promise<ReportLearningSupport | null> {
    uuid(ownerId); uuid(sessionId); uuid(token);
    return this.executor.withTransaction(async tx => {
      if (!rows(await tx.query(LOCK_VALID_CLAIM_SQL, [ownerId, sessionId, token]), 0, 1).length) return null;
      const existing = rows(await tx.query(FIND_REPORT_SQL, [ownerId, sessionId]), 1, 1)[0];
      const turns = rows(await tx.query(COMPLETED_TURNS_SQL, [ownerId, sessionId]), 0, 256).map(completedTurn);
      const input = { report: report(existing, sessionId), turns };
      const content = object(object(existing).content);
      const support = parseReportLearningSupport(Object.hasOwn(content, 'learningSupport') ? content.learningSupport : value, input);
      if (!Object.hasOwn(content, 'learningSupport')) {
        rows(await tx.query(`
          UPDATE lingualoop_language_practice_reports AS r
          SET content = jsonb_set(r.content, '{learningSupport}', $3::jsonb, TRUE)
          FROM lingualoop_language_practice_sessions AS s
          WHERE r.session_id = s.id AND s.owner_id = $1::uuid AND s.id = $2::uuid
            AND NOT (r.content ? 'learningSupport')
          RETURNING r.session_id
        `, [ownerId, sessionId, JSON.stringify(support)]), 1, 1);
      }
      await tx.query(DELETE_CLAIM_SQL, [sessionId, token]);
      return support;
    });
  }

  /** Read-only teacher projection: same durable parser, no student impersonation or generation. */
  async findTeacherReport(teacherId: string, practiceId: string, sessionId: string): Promise<LanguagePracticeReport | null> {
    uuid(teacherId);
    uuid(practiceId);
    uuid(sessionId);
    try {
      const result = rows(await this.executor.query(`
        SELECT r.content, r.generated_with_ai, r.created_at, r.parameter_coverage, s.parameters_snapshot,
          ARRAY(SELECT t.sequence FROM lingualoop_language_practice_turns AS t
            WHERE t.session_id = s.id AND t.status = 'COMPLETED' AND btrim(t.transcript) <> '') AS student_sequences
        FROM lingualoop_language_practice_reports AS r
        INNER JOIN lingualoop_language_practice_sessions AS s ON s.id = r.session_id
        INNER JOIN lingualoop_practices AS p ON p.id = s.practice_id
        WHERE p.teacher_id = $1::uuid AND p.id = $2::uuid AND s.id = $3::uuid
      `, [teacherId, practiceId, sessionId]), 0, 1);
      return result.length ? report(result[0], sessionId) : null;
    } catch { throw new LanguagePracticeReportStoreError(); }
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
          await tx.query(INSERT_REPORT_SQL, [sessionId, JSON.stringify(buildLanguagePracticeReportFallback(turns)), JSON.stringify(unassessedCoverage(parsePracticeParameters(sessionRow.parameters_snapshot ?? [])))]);
          const stored = rows(await tx.query(FIND_REPORT_SQL, [ownerId, sessionId]), 1, 1)[0];
          return { value: { kind: 'no_evidence' as const, report: report(stored, sessionId) } };
        }

        // Validate persisted context before acquiring a durable claim; SQL NULL stays unknown.
        const difficulty = parsePracticeDifficulty(sessionRow.difficulty);
        const token = randomUUID();
        const claim = rows(await tx.query(CLAIM_REPORT_SQL, [sessionId, token]), 0, 1);
        if (claim.length === 0) return { value: { kind: 'busy' as const } };
        const claimRow = object(claim[0]);
        if (claimRow.claim_token !== token || typeof sessionRow.topic !== 'string' || typeof sessionRow.level !== 'string') {
          throw new LanguagePracticeReportStoreError();
        }
        return { value: { kind: 'claimed' as const, token, turns, topic: practiceTopicLabel(sessionRow.topic, sessionRow.conversation_theme_snapshot), level: sessionRow.level, difficulty, parameters: parsePracticeParameters(sessionRow.parameters_snapshot ?? []) } };
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
    content: LanguagePracticeReportFallback & { parameterCoverage?: ParameterCoverage[] },
  ): Promise<LanguagePracticeReport | null> {
    uuid(ownerId);
    uuid(sessionId);
    uuid(token);
    // Reuse the durable report parser as the exact content/size validator before any write.
    const { parameterCoverage, ...legacyContent } = content;
    report({ content: legacyContent, generated_with_ai: true, created_at: new Date() }, sessionId);
    try {
      const result = await this.executor.withTransaction(async (tx) => {
        const claim = rows(await tx.query(LOCK_VALID_CLAIM_SQL, [ownerId, sessionId, token]), 0, 1);
        if (claim.length === 0) return { value: null };
        const parameters = parsePracticeParameters(object(claim[0]).parameters_snapshot ?? []);
        const turns = parameters.length ? rows(await tx.query(COMPLETED_TURNS_SQL, [ownerId, sessionId]), 0, 256).map(completedTurn) : [];
        const coverage = validateParameterCoverage(parameterCoverage ?? [], parameters, new Set(turns.filter(turn => turn.transcript.trim()).map(turn => turn.sequence)));
        await tx.query(INSERT_AI_REPORT_SQL, [sessionId, JSON.stringify(legacyContent), JSON.stringify(coverage)]);
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
        await tx.query(INSERT_REPORT_SQL, [sessionId, JSON.stringify(fallback), JSON.stringify(unassessedCoverage(parsePracticeParameters(sessionRow.parameters_snapshot ?? [])))]);
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
