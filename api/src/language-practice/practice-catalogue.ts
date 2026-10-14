import { randomUUID } from 'node:crypto';
import { isNormalizedPracticeImage, MAX_PRACTICE_IMAGE_BYTES, type NormalizedPracticeImage } from './practice-image';
import { validateAccountName } from '../auth/account-store';
import { normalizeEmail } from '../auth/account-role';
import type { QueryExecutor } from '../auth/identity-store';
import { LANGUAGE_PRACTICE_DURATIONS_MINUTES, LANGUAGE_PRACTICE_LEVELS, LANGUAGE_PRACTICE_TOPICS, inputPracticeDifficulty, parsePracticeDifficulty, type PracticeDifficulty, type LanguagePracticeSetup } from './language-practice-session-store';

export interface PracticeParameter { id: string; requirement: string }
export interface PracticeDto {
  id: string;
  teacherId: string;
  teacherName: string;
  title: string;
  setup: Omit<LanguagePracticeSetup, 'difficulty'> & { difficulty: PracticeDifficulty | null };
  parameters: PracticeParameter[];
  createdAt: string;
  hasImage: boolean;
}
export const PRACTICE_CATALOGUE_STORE = Symbol('PRACTICE_CATALOGUE_STORE');
export const PRACTICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class PracticeCatalogueError extends Error {
  constructor() { super('Practice catalogue unavailable.'); }
}
export function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new TypeError('Invalid practice input.');
  return value as Record<string, unknown>;
}
/** Preserve ordinary whitespace and Unicode; reject other controls and broken UTF-16. */
export function validatePracticeText(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new TypeError('Invalid practice text.');
}
export function validatePracticeInput(value: unknown): { title: string; setup: Omit<LanguagePracticeSetup, 'topic' | 'difficulty'> & { difficulty: PracticeDifficulty }; parameters: { requirement: string }[] } {
  const body = exactObject(value, ['title', 'setup', 'parameters']);
  validatePracticeText(body.title, 120);
  const setup = exactObject(body.setup, body.setup && typeof body.setup === 'object' && Object.hasOwn(body.setup, 'difficulty')
    ? ['level', 'durationMinutes', 'difficulty'] : ['level', 'durationMinutes']);
  const difficulty = inputPracticeDifficulty(setup);
  if (!(LANGUAGE_PRACTICE_LEVELS as readonly unknown[]).includes(setup.level) ||
      !(LANGUAGE_PRACTICE_DURATIONS_MINUTES as readonly unknown[]).includes(setup.durationMinutes)) throw new TypeError('Invalid practice setup.');
  if (!Array.isArray(body.parameters) || body.parameters.length < 1 || body.parameters.length > 20) throw new TypeError('Invalid parameters.');
  const parameters = body.parameters.map(value => {
    const parameter = exactObject(value, ['requirement']);
    validatePracticeText(parameter.requirement, 500);
    return { requirement: parameter.requirement };
  });
  return { title: body.title, setup: { level: setup.level as LanguagePracticeSetup['level'], durationMinutes: setup.durationMinutes as LanguagePracticeSetup['durationMinutes'], difficulty }, parameters };
}
/** Durable ordered snapshots are validated independently of the mutable catalogue. */
export function parsePracticeParameters(value: unknown): PracticeParameter[] {
  if (!Array.isArray(value) || value.length > 20) throw new TypeError('Invalid parameters snapshot.');
  const seen = new Set<string>();
  return value.map(item => {
    const row = exactObject(item, ['id', 'requirement']);
    if (typeof row.id !== 'string' || !PRACTICE_UUID.test(row.id) || seen.has(row.id)) throw new TypeError('Invalid parameter identifier.');
    seen.add(row.id);
    validatePracticeText(row.requirement, 500);
    return { id: row.id, requirement: row.requirement };
  });
}
function practice(value: unknown): PracticeDto {
  if (!value || typeof value !== 'object') throw new PracticeCatalogueError();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !PRACTICE_UUID.test(row.id) || typeof row.teacher_id !== 'string' || !PRACTICE_UUID.test(row.teacher_id)) throw new PracticeCatalogueError();
  const parameters = parsePracticeParameters(row.parameters);
  // Durable catalogue rows retain all original categories independently of creation input.
  validatePracticeText(row.title, 120);
  if (!(LANGUAGE_PRACTICE_TOPICS as readonly unknown[]).includes(row.topic) ||
      !(LANGUAGE_PRACTICE_LEVELS as readonly unknown[]).includes(row.level) ||
      !(LANGUAGE_PRACTICE_DURATIONS_MINUTES as readonly unknown[]).includes(row.duration_minutes) ||
      parameters.length === 0) throw new PracticeCatalogueError();
  if (row.conversation_theme != null) validatePracticeText(row.conversation_theme, 120);
  const setup: PracticeDto['setup'] = { difficulty: parsePracticeDifficulty(row.difficulty), topic: row.topic as LanguagePracticeSetup['topic'],
    level: row.level as LanguagePracticeSetup['level'], durationMinutes: row.duration_minutes as LanguagePracticeSetup['durationMinutes'] };
  const date = row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string);
  if (!Number.isFinite(date.valueOf())) throw new PracticeCatalogueError();
  validateAccountName(row.teacher_name);
  return { id: row.id, teacherId: row.teacher_id, teacherName: row.teacher_name, title: row.title, setup, parameters, createdAt: date.toISOString(), hasImage: row.has_image === true };
}
export interface PracticeSubmissionDto {
  sessionId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  status: 'ACTIVE' | 'EXPIRED' | 'COMPLETED';
  startedAt: string;
  completedAt: string | null;
  reportAvailable: boolean;
}
function submission(value: unknown): PracticeSubmissionDto {
  if (!value || typeof value !== 'object') throw new TypeError();
  const row = value as Record<string, unknown>;
  if (typeof row.session_id !== 'string' || !PRACTICE_UUID.test(row.session_id) ||
      typeof row.student_id !== 'string' || !PRACTICE_UUID.test(row.student_id) ||
      !['ACTIVE', 'EXPIRED', 'COMPLETED'].includes(row.status as string) || typeof row.report_available !== 'boolean') throw new TypeError();
  validateAccountName(row.student_name);
  if (normalizeEmail(row.student_email) !== row.student_email) throw new TypeError();
  const date = (value: unknown) => {
    const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
    if (!parsed || !Number.isFinite(parsed.valueOf())) throw new TypeError();
    return parsed.toISOString();
  };
  return { sessionId: row.session_id, studentId: row.student_id, studentName: row.student_name,
    studentEmail: row.student_email as string, status: row.status as PracticeSubmissionDto['status'],
    startedAt: date(row.started_at), completedAt: row.completed_at === null ? null : date(row.completed_at),
    reportAvailable: row.report_available };
}
export class PracticeCatalogueStore {
  constructor(private readonly executor: QueryExecutor) {}
  async create(teacherId: string, value: { title: string; setup: Omit<LanguagePracticeSetup, 'topic'>; parameters: { requirement: string }[] }, image?: NormalizedPracticeImage): Promise<PracticeDto> {
    try {
      if (!PRACTICE_UUID.test(teacherId)) throw new TypeError();
      const input = validatePracticeInput(value);
      if (image !== undefined && !isNormalizedPracticeImage(image)) throw new TypeError();
      const parameters = input.parameters.map(item => ({ id: randomUUID(), requirement: item.requirement }));
      const result = await this.executor.query(`WITH inserted AS (
        INSERT INTO lingualoop_practices (teacher_id, title, conversation_theme, topic, level, duration_minutes, parameters, difficulty)
        VALUES ($1::uuid, $2, $2, $3, $4, $5, $6::jsonb, $8) RETURNING *),
        inserted_image AS (
          INSERT INTO lingualoop_practice_images (practice_id, bytes, mime)
          SELECT id, $7::bytea, 'image/jpeg' FROM inserted WHERE $7::bytea IS NOT NULL RETURNING practice_id)
        SELECT p.*, a.name AS teacher_name, EXISTS (SELECT 1 FROM inserted_image) AS has_image FROM inserted AS p
        INNER JOIN lingualoop_accounts AS a ON a.id = p.teacher_id`, [teacherId, input.title, 'everyday-conversation', input.setup.level, input.setup.durationMinutes, JSON.stringify(parameters), image?.bytes ?? null, input.setup.difficulty]);
      if (result.rows.length !== 1) throw new TypeError();
      return practice(result.rows[0]);
    } catch { throw new PracticeCatalogueError(); }
  }
  async submissions(teacherId: string, practiceId: string): Promise<PracticeSubmissionDto[] | null> {
    try {
      if (!PRACTICE_UUID.test(teacherId) || !PRACTICE_UUID.test(practiceId)) throw new TypeError();
      const owned = await this.executor.query('SELECT id FROM lingualoop_practices WHERE id = $1::uuid AND teacher_id = $2::uuid', [practiceId, teacherId]);
      if (!owned.rows.length) return null;
      if (owned.rows.length !== 1) throw new TypeError();
      const result = await this.executor.query(`
        SELECT s.id AS session_id, a.id AS student_id, a.name AS student_name, a.email AS student_email,
          CASE WHEN s.status = 'ACTIVE' AND s.expires_at <= clock_timestamp() THEN 'EXPIRED' ELSE s.status END AS status,
          s.started_at, s.completed_at, r.session_id IS NOT NULL AS report_available
        FROM lingualoop_language_practice_sessions AS s
        INNER JOIN lingualoop_practices AS p ON p.id = s.practice_id
        INNER JOIN lingualoop_accounts AS a ON a.id = s.owner_id AND a.role = 'student'
        LEFT JOIN lingualoop_language_practice_reports AS r ON r.session_id = s.id
        WHERE p.id = $1::uuid AND p.teacher_id = $2::uuid
        ORDER BY s.started_at ASC, s.id ASC
      `, [practiceId, teacherId]);
      return result.rows.map(submission);
    } catch { throw new PracticeCatalogueError(); }
  }
  async list(ownerId: string, role: 'student' | 'teacher'): Promise<PracticeDto[]> {
    try {
      if (!PRACTICE_UUID.test(ownerId) || !['student', 'teacher'].includes(role)) throw new TypeError();
      const result = await this.executor.query(`SELECT p.*, a.name AS teacher_name,
        EXISTS (SELECT 1 FROM lingualoop_practice_images AS i WHERE i.practice_id = p.id) AS has_image FROM lingualoop_practices AS p
        INNER JOIN lingualoop_accounts AS a ON a.id = p.teacher_id
        ${role === 'teacher' ? 'WHERE p.teacher_id = $1::uuid' : ''} ORDER BY p.created_at ASC, p.id ASC`, role === 'teacher' ? [ownerId] : []);
      return result.rows.map(practice);
    } catch { throw new PracticeCatalogueError(); }
  }
  async image(ownerId: string, role: 'student' | 'teacher', id: string): Promise<{ bytes: Buffer; mime: 'image/jpeg' } | null> {
    try {
      if (!PRACTICE_UUID.test(ownerId) || !PRACTICE_UUID.test(id) || !['student', 'teacher'].includes(role)) throw new TypeError();
      const result = await this.executor.query(`SELECT i.bytes, i.mime FROM lingualoop_practice_images AS i
        INNER JOIN lingualoop_practices AS p ON p.id = i.practice_id
        WHERE p.id = $1::uuid ${role === 'teacher' ? 'AND p.teacher_id = $2::uuid' : ''}`, role === 'teacher' ? [id, ownerId] : [id]);
      if (result.rows.length > 1) throw new TypeError();
      if (!result.rows.length) return null;
      const row = result.rows[0] as { bytes: unknown; mime: unknown };
      if (!Buffer.isBuffer(row.bytes) || !row.bytes.length || row.bytes.length > MAX_PRACTICE_IMAGE_BYTES || row.mime !== 'image/jpeg') throw new TypeError();
      return { bytes: row.bytes, mime: 'image/jpeg' };
    } catch { throw new PracticeCatalogueError(); }
  }
  async detail(ownerId: string, role: 'student' | 'teacher', id: string): Promise<PracticeDto | null> {
    try {
      if (!PRACTICE_UUID.test(ownerId) || !PRACTICE_UUID.test(id) || !['student', 'teacher'].includes(role)) throw new TypeError();
      const result = await this.executor.query(`SELECT p.*, a.name AS teacher_name,
        EXISTS (SELECT 1 FROM lingualoop_practice_images AS i WHERE i.practice_id = p.id) AS has_image FROM lingualoop_practices AS p
        INNER JOIN lingualoop_accounts AS a ON a.id = p.teacher_id
        WHERE p.id = $1::uuid ${role === 'teacher' ? 'AND p.teacher_id = $2::uuid' : ''}`, role === 'teacher' ? [id, ownerId] : [id]);
      if (result.rows.length > 1) throw new TypeError();
      return result.rows.length ? practice(result.rows[0]) : null;
    } catch { throw new PracticeCatalogueError(); }
  }
}
