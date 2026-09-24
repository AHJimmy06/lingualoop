import type { QueryExecutor, QueryResult } from '../auth/identity-store';

export type LanguagePracticeTurnStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface LanguagePracticeTurn {
  id: string;
  clientTurnId: string;
  sequence: number;
  status: LanguagePracticeTurnStatus;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  transcript: string | null;
  assistantResponse: string | null;
  failureCode: string | null;
  spanishCorrectionEvidence: string | null;
  completedAt: string | null;
}

export interface LanguagePracticeTurnReservation {
  turn: LanguagePracticeTurn;
  replay: boolean;
}

export class LanguagePracticeTurnStoreError extends Error {
  constructor() {
    super('Language practice turn store operation failed.');
    this.name = 'LanguagePracticeTurnStoreError';
  }
}

export class LanguagePracticeTurnAdmissionError extends Error {
  constructor(readonly reason: 'not_found' | 'session_expired' | 'turn_in_progress') {
    super(reason);
    this.name = 'LanguagePracticeTurnAdmissionError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVE_SQL = `
  SELECT * FROM lingualoop_reserve_language_practice_turn($1::uuid, $2::uuid, $3::uuid)
`;
const COMPLETE_SQL = `
  SELECT lingualoop_complete_language_practice_turn(
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text
  ) AS completed
`;
const FAIL_SQL = `
  SELECT lingualoop_fail_language_practice_turn($1::uuid, $2::uuid, $3::uuid, $4::uuid) AS failed
`;
const COMPLETED_TURNS_SQL = `
  WITH recent_completed AS (
    SELECT t.sequence, LEFT(t.transcript, 2000) AS transcript,
      LEFT(t.assistant_response, 2000) AS assistant_response, t.completed_at
    FROM lingualoop_language_practice_turns AS t
    INNER JOIN lingualoop_language_practice_sessions AS s ON s.id = t.session_id
    WHERE s.owner_id = $1::uuid AND s.id = $2::uuid AND t.status = 'COMPLETED'
    ORDER BY t.sequence DESC
    LIMIT 256
  )
  SELECT sequence, transcript, assistant_response, completed_at
  FROM recent_completed
  ORDER BY sequence ASC
`;
const COMPLETED_HISTORY_SQL = `
  WITH recent_completed AS (
    SELECT t.sequence, LEFT(t.transcript, 2000) AS transcript,
      LEFT(t.assistant_response, 2000) AS assistant_response
    FROM lingualoop_language_practice_turns AS t
    INNER JOIN lingualoop_language_practice_sessions AS s ON s.id = t.session_id
    WHERE s.owner_id = $1::uuid AND s.id = $2::uuid AND t.status = 'COMPLETED'
    ORDER BY t.sequence DESC
    LIMIT 10
  )
  SELECT transcript, assistant_response
  FROM recent_completed
  ORDER BY sequence ASC
`;

function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new LanguagePracticeTurnStoreError();
}

function rows(result: QueryResult, minimum: number, maximum: number): unknown[] {
  if (!result || !Array.isArray(result.rows) || result.rows.length < minimum || result.rows.length > maximum) {
    throw new LanguagePracticeTurnStoreError();
  }
  return result.rows;
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) throw new LanguagePracticeTurnStoreError();
  return date.toISOString();
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new LanguagePracticeTurnStoreError();
  return value;
}

function turn(value: unknown): LanguagePracticeTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LanguagePracticeTurnStoreError();
  const row = value as Record<string, unknown>;
  uuid(row.turn_id);
  uuid(row.client_turn_id);
  if (!Number.isSafeInteger(row.turn_sequence) || (row.turn_sequence as number) < 1 ||
      (row.turn_status !== 'PROCESSING' && row.turn_status !== 'COMPLETED' && row.turn_status !== 'FAILED')) {
    throw new LanguagePracticeTurnStoreError();
  }
  if (row.lease_token !== null) uuid(row.lease_token);
  return {
    id: row.turn_id,
    clientTurnId: row.client_turn_id,
    sequence: row.turn_sequence as number,
    status: row.turn_status,
    leaseToken: row.lease_token as string | null,
    leaseExpiresAt: nullableTimestamp(row.lease_expires_at),
    transcript: nullableText(row.transcript),
    assistantResponse: nullableText(row.assistant_response),
    failureCode: nullableText(row.failure_code),
    spanishCorrectionEvidence: nullableText(row.spanish_correction_evidence),
    completedAt: nullableTimestamp(row.completed_at),
  };
}

function lease(value: unknown): asserts value is string {
  uuid(value);
}

function boundedHistoryText(value: string): string {
  const clipped = value.slice(0, 2000);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

/** A completed turn returned in the protected session detail response. */
export interface LanguagePracticeCompletedTurn {
  sequence: number;
  transcript: string;
  assistantResponse: string;
  completedAt: string;
}

/** A completed learner/assistant message returned as bounded coaching history. */
export interface LanguagePracticeHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

/** Persists turn text only; uploaded audio is never accepted by this boundary. */
export class LanguagePracticeTurnStore {
  constructor(private readonly executor: QueryExecutor) {
    if (!executor || typeof executor.query !== 'function') throw new TypeError('A query executor is required.');
  }

  async reserveTurn(ownerId: string, sessionId: string, clientTurnId: string): Promise<LanguagePracticeTurnReservation> {
    uuid(ownerId);
    uuid(sessionId);
    uuid(clientTurnId);
    try {
      const result = rows(await this.executor.query(RESERVE_SQL, [ownerId, sessionId, clientTurnId]), 1, 1)[0];
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new LanguagePracticeTurnStoreError();
      const row = result as Record<string, unknown>;
      if (row.outcome === 'not_found' || row.outcome === 'session_expired' || row.outcome === 'turn_in_progress') {
        throw new LanguagePracticeTurnAdmissionError(row.outcome);
      }
      if (row.outcome !== 'admitted' && row.outcome !== 'replay') throw new LanguagePracticeTurnStoreError();
      const reserved = turn(row);
      if (row.outcome === 'admitted' && (!reserved.leaseToken || !reserved.leaseExpiresAt || reserved.status !== 'PROCESSING')) {
        throw new LanguagePracticeTurnStoreError();
      }
      return { turn: reserved, replay: row.outcome === 'replay' };
    } catch (error) {
      if (error instanceof LanguagePracticeTurnAdmissionError) throw error;
      throw new LanguagePracticeTurnStoreError();
    }
  }

  async completeTurn(
    ownerId: string,
    sessionId: string,
    turnId: string,
    leaseToken: string,
    transcript: string,
    assistantResponse: string,
    spanishCorrectionEvidence: string,
  ): Promise<boolean> {
    uuid(ownerId);
    uuid(sessionId);
    uuid(turnId);
    lease(leaseToken);
    if (typeof transcript !== 'string' || typeof assistantResponse !== 'string' ||
        typeof spanishCorrectionEvidence !== 'string' || transcript.length === 0 ||
        assistantResponse.length === 0) throw new LanguagePracticeTurnStoreError();
    try {
      const row = rows(await this.executor.query(COMPLETE_SQL, [
        ownerId, sessionId, turnId, leaseToken, transcript, assistantResponse,
        spanishCorrectionEvidence.slice(0, 2000),
      ]), 1, 1)[0] as { completed?: unknown } | null;
      if (!row || typeof row.completed !== 'boolean') throw new LanguagePracticeTurnStoreError();
      return row.completed;
    } catch {
      throw new LanguagePracticeTurnStoreError();
    }
  }

  /** Returns at most 256 latest completed turns in chronological order. */
  async listCompletedTurns(ownerId: string, sessionId: string): Promise<LanguagePracticeCompletedTurn[]> {
    uuid(ownerId);
    uuid(sessionId);
    try {
      const completedRows = rows(await this.executor.query(COMPLETED_TURNS_SQL, [ownerId, sessionId]), 0, 256);
      return completedRows.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LanguagePracticeTurnStoreError();
        const row = value as Record<string, unknown>;
        if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1 ||
            typeof row.transcript !== 'string' || typeof row.assistant_response !== 'string') {
          throw new LanguagePracticeTurnStoreError();
        }
        const completedAt = nullableTimestamp(row.completed_at);
        if (completedAt === null) throw new LanguagePracticeTurnStoreError();
        return {
          sequence: row.sequence as number,
          transcript: boundedHistoryText(row.transcript),
          assistantResponse: boundedHistoryText(row.assistant_response),
          completedAt,
        };
      });
    } catch {
      throw new LanguagePracticeTurnStoreError();
    }
  }

  /** Returns this owner's last ten completed turns in chronological learner/assistant order. */
  async getCompletedHistory(ownerId: string, sessionId: string): Promise<LanguagePracticeHistoryEntry[]> {
    uuid(ownerId);
    uuid(sessionId);
    try {
      const historyRows = rows(await this.executor.query(COMPLETED_HISTORY_SQL, [ownerId, sessionId]), 0, 10);
      const history: LanguagePracticeHistoryEntry[] = [];
      for (const value of historyRows) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LanguagePracticeTurnStoreError();
        const row = value as Record<string, unknown>;
        if (typeof row.transcript !== 'string' || typeof row.assistant_response !== 'string') {
          throw new LanguagePracticeTurnStoreError();
        }
        history.push(
          { role: 'user', content: boundedHistoryText(row.transcript) },
          { role: 'assistant', content: boundedHistoryText(row.assistant_response) },
        );
      }
      return history;
    } catch {
      throw new LanguagePracticeTurnStoreError();
    }
  }

  async failTurn(ownerId: string, sessionId: string, turnId: string, leaseToken: string): Promise<boolean> {
    uuid(ownerId);
    uuid(sessionId);
    uuid(turnId);
    lease(leaseToken);
    try {
      const row = rows(await this.executor.query(FAIL_SQL, [ownerId, sessionId, turnId, leaseToken]), 1, 1)[0] as { failed?: unknown } | null;
      if (!row || typeof row.failed !== 'boolean') throw new LanguagePracticeTurnStoreError();
      return row.failed;
    } catch {
      throw new LanguagePracticeTurnStoreError();
    }
  }
}
