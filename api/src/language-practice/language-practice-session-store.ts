import type { QueryExecutor, QueryResult } from '../auth/identity-store';

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

export interface LanguagePracticeSetup {
  level: LanguagePracticeLevel;
  topic: LanguagePracticeTopic;
  durationMinutes: LanguagePracticeDurationMinutes;
}

export interface LanguagePracticeSession {
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_SESSION_SQL = `
  INSERT INTO lingualoop_language_practice_sessions
    (owner_id, level, topic, duration_minutes, started_at, expires_at)
  VALUES ($1, $2, $3, $4, NOW(), NOW() + $4 * INTERVAL '1 minute')
  RETURNING id, status, level, topic,
    duration_minutes AS "durationMinutes",
    started_at AS "startedAt", expires_at AS "expiresAt",
    duration_minutes * 60000 AS "remainingMs"
`;
const FIND_SESSION_SQL = `
  SELECT id,
    CASE WHEN status = 'COMPLETED' THEN status
      WHEN expires_at <= NOW() THEN 'EXPIRED' ELSE status END AS status,
    level, topic,
    duration_minutes AS "durationMinutes",
    started_at AS "startedAt", expires_at AS "expiresAt",
    GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - NOW())) * 1000)::INTEGER) AS "remainingMs"
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
    status: row.status,
    level: row.level as LanguagePracticeLevel,
    topic: row.topic as LanguagePracticeTopic,
    durationMinutes: row.durationMinutes as LanguagePracticeDurationMinutes,
    startedAt: timestamp(row.startedAt),
    expiresAt: timestamp(row.expiresAt),
    remainingMs: row.remainingMs,
    turnInProgress: false,
  };
}

function validateSetup(value: unknown): asserts value is LanguagePracticeSetup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LanguagePracticeSessionStoreError();
  const setup = value as Record<string, unknown>;
  if (!(LANGUAGE_PRACTICE_LEVELS as readonly unknown[]).includes(setup.level) ||
      !(LANGUAGE_PRACTICE_TOPICS as readonly unknown[]).includes(setup.topic) ||
      !(LANGUAGE_PRACTICE_DURATIONS_MINUTES as readonly unknown[]).includes(setup.durationMinutes)) {
    throw new LanguagePracticeSessionStoreError();
  }
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
      ]), 1, 1)[0]);
    } catch {
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
