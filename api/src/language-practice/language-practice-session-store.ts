import type { QueryExecutor, QueryResult } from '../auth/identity-store';
import { parsePracticeParameters, type PracticeParameter } from './practice-catalogue';
import { parseConversationTheme } from './practice-topic-labels';

export const LANGUAGE_PRACTICE_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export const LANGUAGE_PRACTICE_DURATIONS_MINUTES = [5, 10, 15] as const;
export const LANGUAGE_PRACTICE_TOPICS = [
  'travel',
  'work',
  'studies',
  'everyday-conversation',
] as const;

export type LanguagePracticeLevel = (typeof LANGUAGE_PRACTICE_LEVELS)[number];
export type LanguagePracticeDurationMinutes = (typeof LANGUAGE_PRACTICE_DURATIONS_MINUTES)[number];
export type LanguagePracticeTopic = (typeof LANGUAGE_PRACTICE_TOPICS)[number];

export const PRACTICE_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type PracticeDifficulty = (typeof PRACTICE_DIFFICULTIES)[number];

/** SQL NULL means historical difficulty is unknown, never an inferred medium. */
export function parsePracticeDifficulty(value: unknown): PracticeDifficulty | null {
  if (value === null) return null;
  if (!(PRACTICE_DIFFICULTIES as readonly unknown[]).includes(value)) throw new TypeError('Invalid practice difficulty.');
  return value as PracticeDifficulty;
}

/** Only omission defaults new input; explicit null/undefined and invalid values fail closed. */
export function inputPracticeDifficulty(input: Record<string, unknown>): PracticeDifficulty {
  if (!Object.hasOwn(input, 'difficulty')) return 'medium';
  const difficulty = parsePracticeDifficulty(input.difficulty);
  if (difficulty === null) throw new TypeError('Invalid practice difficulty.');
  return difficulty;
}

export interface LanguagePracticeSetup {
  difficulty?: PracticeDifficulty;
  level: LanguagePracticeLevel;
  topic: LanguagePracticeTopic;
  durationMinutes: LanguagePracticeDurationMinutes;
}

export interface LanguagePracticeSession {
  difficulty: PracticeDifficulty | null;
  id: string;
  status: 'ACTIVE' | 'EXPIRED' | 'COMPLETED';
  level: LanguagePracticeLevel;
  topic: LanguagePracticeTopic;
  durationMinutes: LanguagePracticeDurationMinutes;
  startedAt: string;
  expiresAt: string;
  remainingMs: number;
  turnInProgress: false;
}

export class LanguagePracticeSessionStoreError extends Error {
  constructor() {
    super('Language practice session store operation failed.');
    this.name = 'LanguagePracticeSessionStoreError';
  }
}

export class LanguagePracticeSessionFinishError extends Error {
  constructor(readonly reason: 'turn_in_progress') {
    super(reason);
    this.name = 'LanguagePracticeSessionFinishError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_SESSION_SQL = `
  INSERT INTO lingualoop_language_practice_sessions
    (owner_id, level, topic, duration_minutes, difficulty, started_at, expires_at)
  VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + $4::integer * INTERVAL '1 minute')
  RETURNING id, status, level, topic, difficulty,
    duration_minutes AS "durationMinutes",
    started_at AS "startedAt", expires_at AS "expiresAt",
    duration_minutes * 60000 AS "remainingMs"
`;
const FIND_SESSION_SQL = `
  SELECT id,
    CASE WHEN status = 'COMPLETED' THEN status
      WHEN expires_at <= NOW() THEN 'EXPIRED' ELSE status END AS status,
    level, topic, difficulty,
    duration_minutes AS "durationMinutes",
    started_at AS "startedAt", expires_at AS "expiresAt",
    GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - NOW())) * 1000)::INTEGER) AS "remainingMs"
  FROM lingualoop_language_practice_sessions
  WHERE owner_id = $1 AND id = $2
`;
const FINISH_SESSION_SQL = `
  UPDATE lingualoop_language_practice_sessions
  SET status = 'COMPLETED', completed_at = COALESCE(completed_at, clock_timestamp())
  WHERE owner_id = $1 AND id = $2 AND status = 'ACTIVE'
    AND expires_at > clock_timestamp() AND active_turn_lease_token IS NULL
  RETURNING id, status
`;
const FIND_FINISH_STATE_SQL = `
  SELECT id, status, active_turn_lease_token AS "activeTurnLeaseToken",
    expires_at <= clock_timestamp() AS elapsed
  FROM lingualoop_language_practice_sessions
  WHERE owner_id = $1 AND id = $2
`;

function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new LanguagePracticeSessionStoreError();
}

function rows(result: QueryResult, minimum: number, maximum: number): unknown[] {
  if (!result || !Array.isArray(result.rows) || result.rows.length < minimum || result.rows.length > maximum) {
    throw new LanguagePracticeSessionStoreError();
  }
  return result.rows;
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) throw new LanguagePracticeSessionStoreError();
  return date.toISOString();
}

function session(value: unknown): LanguagePracticeSession {
  if (!value || typeof value !== 'object') throw new LanguagePracticeSessionStoreError();
  const row = value as Record<string, unknown>;
  uuid(row.id);
  if (!(LANGUAGE_PRACTICE_LEVELS as readonly unknown[]).includes(row.level) ||
      !(LANGUAGE_PRACTICE_TOPICS as readonly unknown[]).includes(row.topic) ||
      !(LANGUAGE_PRACTICE_DURATIONS_MINUTES as readonly unknown[]).includes(row.durationMinutes) ||
      (row.status !== 'ACTIVE' && row.status !== 'EXPIRED' && row.status !== 'COMPLETED')) {
    throw new LanguagePracticeSessionStoreError();
  }
  if (typeof row.remainingMs !== 'number' || !Number.isSafeInteger(row.remainingMs) || row.remainingMs < 0) {
    throw new LanguagePracticeSessionStoreError();
  }
  return {
    id: row.id,
    difficulty: parsePracticeDifficulty(row.difficulty),
    status: row.status,
    level: row.level as LanguagePracticeLevel,
    topic: row.topic as LanguagePracticeTopic,
    durationMinutes: row.durationMinutes as LanguagePracticeDurationMinutes,
    startedAt: timestamp(row.startedAt),
    expiresAt: timestamp(row.expiresAt),
    remainingMs: row.status === 'COMPLETED' ? 0 : row.remainingMs,
    turnInProgress: false,
  };
}

function validateSetup(value: unknown): asserts value is LanguagePracticeSetup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LanguagePracticeSessionStoreError();
  const setup = value as Record<string, unknown>;
  if (!(LANGUAGE_PRACTICE_LEVELS as readonly unknown[]).includes(setup.level) ||
      !(LANGUAGE_PRACTICE_TOPICS as readonly unknown[]).includes(setup.topic) ||
      !(LANGUAGE_PRACTICE_DURATIONS_MINUTES as readonly unknown[]).includes(setup.durationMinutes) ||
      Object.keys(setup).some(key => !['level', 'topic', 'durationMinutes', 'difficulty'].includes(key))) {
    throw new LanguagePracticeSessionStoreError();
  }
  try { inputPracticeDifficulty(setup); } catch { throw new LanguagePracticeSessionStoreError(); }
}

/** Stores only original setup/session state; ownership always comes from the verified caller context. */
export class LanguagePracticeSessionStore {
  constructor(private readonly executor: QueryExecutor) {
    if (!executor || typeof executor.query !== 'function') throw new TypeError('A query executor is required.');
  }

  async createSession(ownerId: string, setup: LanguagePracticeSetup): Promise<LanguagePracticeSession> {
    uuid(ownerId);
    validateSetup(setup);
    try {
      return session(rows(await this.executor.query(CREATE_SESSION_SQL, [
        ownerId, setup.level, setup.topic, setup.durationMinutes,
        inputPracticeDifficulty(setup as unknown as Record<string, unknown>),
      ]), 1, 1)[0]);
    } catch {
      throw new LanguagePracticeSessionStoreError();
    }
  }

  /** One INSERT...SELECT copies authoritative catalogue data in a single database statement. */
  async createCustomSession(ownerId: string, practiceId: string): Promise<LanguagePracticeSession | null> {
    uuid(ownerId);
    uuid(practiceId);
    try {
      const result = rows(await this.executor.query(`
        INSERT INTO lingualoop_language_practice_sessions
          (owner_id, level, topic, duration_minutes, started_at, expires_at, practice_id, parameters_snapshot, conversation_theme_snapshot, difficulty)
        SELECT $1::uuid, level, topic, duration_minutes, NOW(), NOW() + duration_minutes * INTERVAL '1 minute', id, parameters, conversation_theme, difficulty
        FROM lingualoop_practices WHERE id = $2::uuid
        RETURNING id, status, level, topic, difficulty, duration_minutes AS "durationMinutes",
          started_at AS "startedAt", expires_at AS "expiresAt", duration_minutes * 60000 AS "remainingMs"
      `, [ownerId, practiceId]), 0, 1);
      return result.length ? session(result[0]) : null;
    } catch { throw new LanguagePracticeSessionStoreError(); }
  }

  /** Owned durable snapshot, including nullable difficulty. No catalogue lookup. */
  async getOwnedSnapshot(ownerId: string, sessionId: string): Promise<{ level: LanguagePracticeLevel; topic: LanguagePracticeTopic; difficulty: PracticeDifficulty | null; conversationTheme: string | null; parameters: PracticeParameter[] } | null> {
    uuid(ownerId);
    uuid(sessionId);
    try {
      const result = rows(await this.executor.query(`SELECT level, topic, difficulty, parameters_snapshot, conversation_theme_snapshot FROM lingualoop_language_practice_sessions WHERE owner_id = $1::uuid AND id = $2::uuid AND status = 'ACTIVE' AND expires_at > clock_timestamp()`, [ownerId, sessionId]), 0, 1);
      if (!result.length) return null;
      const row = result[0] as Record<string, unknown>;
      if (!(LANGUAGE_PRACTICE_LEVELS as readonly unknown[]).includes(row.level) || !(LANGUAGE_PRACTICE_TOPICS as readonly unknown[]).includes(row.topic)) throw new TypeError();
      return { level: row.level as LanguagePracticeLevel, topic: row.topic as LanguagePracticeTopic, difficulty: parsePracticeDifficulty(row.difficulty), conversationTheme: parseConversationTheme(row.conversation_theme_snapshot), parameters: parsePracticeParameters(row.parameters_snapshot) };
    } catch { throw new LanguagePracticeSessionStoreError(); }
  }

  async finishSession(ownerId: string, sessionId: string): Promise<{ id: string; status: 'COMPLETED' | 'EXPIRED' } | null> {
    uuid(ownerId);
    uuid(sessionId);
    try {
      const updated = rows(await this.executor.query(FINISH_SESSION_SQL, [ownerId, sessionId]), 0, 1);
      if (updated.length) {
        const row = updated[0] as Record<string, unknown>;
        uuid(row.id);
        if (row.status !== 'COMPLETED') throw new LanguagePracticeSessionStoreError();
        return { id: row.id, status: 'COMPLETED' };
      }

      // The conditional UPDATE serializes with turn reservation on the same session row.
      // Re-read after a skipped update to classify a concurrent close or a live lease.
      const stateRows = rows(await this.executor.query(FIND_FINISH_STATE_SQL, [ownerId, sessionId]), 0, 1);
      if (!stateRows.length) return null;
      const state = stateRows[0] as Record<string, unknown>;
      uuid(state.id);
      if (state.status !== 'ACTIVE' && state.status !== 'EXPIRED' && state.status !== 'COMPLETED') {
        throw new LanguagePracticeSessionStoreError();
      }
      if (state.activeTurnLeaseToken !== null && state.activeTurnLeaseToken !== undefined) {
        uuid(state.activeTurnLeaseToken);
        if (state.status === 'ACTIVE') throw new LanguagePracticeSessionFinishError('turn_in_progress');
      }
      if (state.status === 'COMPLETED' || state.status === 'EXPIRED' ||
          (state.status === 'ACTIVE' && state.elapsed === true)) {
        return { id: state.id, status: state.status === 'COMPLETED' ? 'COMPLETED' : 'EXPIRED' };
      }
      throw new LanguagePracticeSessionStoreError();
    } catch (error) {
      if (error instanceof LanguagePracticeSessionFinishError) throw error;
      throw new LanguagePracticeSessionStoreError();
    }
  }

  async getSession(ownerId: string, sessionId: string): Promise<LanguagePracticeSession | null> {
    uuid(ownerId);
    uuid(sessionId);
    try {
      const found = rows(await this.executor.query(FIND_SESSION_SQL, [ownerId, sessionId]), 0, 1);
      return found.length === 0 ? null : session(found[0]);
    } catch {
      throw new LanguagePracticeSessionStoreError();
    }
  }
}
