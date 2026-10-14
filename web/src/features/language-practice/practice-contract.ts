import {
  hasExactKeys, isRecord, isUuid, isTimestamp, LanguagePracticeClientError,
  LANGUAGE_PRACTICE_LEVELS, LANGUAGE_PRACTICE_TOPICS, LANGUAGE_PRACTICE_DURATIONS, LANGUAGE_PRACTICE_DIFFICULTIES,
  type PracticeDifficulty, type PracticeSetup, type ParsedPracticeSetup, type CreatePractice, type TeacherPractice, type ParameterCoverage,
} from './language-practice-client';

export function safeText(value: unknown, maximum: number): value is string {
  // Unicode mode treats valid surrogate pairs as one code point, rejecting only unpaired surrogates.
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]/u.test(value);
}
export function isPracticeDifficulty(value: unknown): value is PracticeDifficulty {
  return typeof value === 'string' && LANGUAGE_PRACTICE_DIFFICULTIES.includes(value as PracticeDifficulty);
}
export function hasSetupKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return hasExactKeys(value, Object.hasOwn(value, 'difficulty') ? [...required, 'difficulty'] : required);
}
export function hasResponseDifficulty(value: Record<string, unknown>): boolean {
  return !Object.hasOwn(value, 'difficulty') || value.difficulty === null || isPracticeDifficulty(value.difficulty);
}
function hasSetupFields(value: Record<string, unknown>): boolean {
  return LANGUAGE_PRACTICE_LEVELS.includes(value.level as PracticeSetup['level']) &&
    LANGUAGE_PRACTICE_TOPICS.includes(value.topic as PracticeSetup['topic']) &&
    LANGUAGE_PRACTICE_DURATIONS.includes(value.durationMinutes as PracticeSetup['durationMinutes']);
}
export function isValidSetup(value: unknown): value is PracticeSetup {
  return isRecord(value) && hasSetupKeys(value, ['topic', 'level', 'durationMinutes']) && hasSetupFields(value) &&
    (!Object.hasOwn(value, 'difficulty') || isPracticeDifficulty(value.difficulty));
}
function isValidResponseSetup(value: unknown): boolean {
  return isRecord(value) && hasSetupKeys(value, ['topic', 'level', 'durationMinutes']) &&
    hasSetupFields(value) && hasResponseDifficulty(value);
}
export const MAX_PRACTICE_IMAGE_BYTES = 2 * 1024 * 1024;
export function validatePracticeImage(value: unknown): asserts value is Blob {
  if (!(value instanceof Blob) || !['image/jpeg', 'image/png', 'image/webp'].includes(value.type) ||
      value.size === 0 || value.size > MAX_PRACTICE_IMAGE_BYTES) throw new LanguagePracticeClientError('invalid-input');
}
function isValidCreateSetup(value: unknown): boolean {
  return isRecord(value) && hasSetupKeys(value, ['level', 'durationMinutes']) &&
    (!Object.hasOwn(value, 'difficulty') || isPracticeDifficulty(value.difficulty)) &&
    LANGUAGE_PRACTICE_LEVELS.includes(value.level as PracticeSetup['level']) &&
    LANGUAGE_PRACTICE_DURATIONS.includes(value.durationMinutes as PracticeSetup['durationMinutes']);
}
export function validateCreatePractice(value: unknown): asserts value is CreatePractice {
  if (!isRecord(value) || !hasExactKeys(value, ['title', 'setup', 'parameters']) || !safeText(value.title, 120) || !isValidCreateSetup(value.setup) ||
      !Array.isArray(value.parameters) || value.parameters.length < 1 || value.parameters.length > 20 ||
      !value.parameters.every(item => isRecord(item) && hasExactKeys(item, ['requirement']) && safeText(item.requirement, 500))) {
    throw new LanguagePracticeClientError('invalid-input');
  }
}
export function parsePractice(value: unknown): TeacherPractice {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'teacherId', 'teacherName', 'title', 'setup', 'parameters', 'createdAt', 'hasImage']) || typeof value.hasImage !== 'boolean' ||
      !isUuid(value.id) || !isUuid(value.teacherId) || !safeText(value.teacherName, 120) || !isTimestamp(value.createdAt) || !safeText(value.title, 120) || !isValidResponseSetup(value.setup) ||
      !Array.isArray(value.parameters) || value.parameters.length < 1 || value.parameters.length > 20 ||
      !value.parameters.every(item => isRecord(item) && hasExactKeys(item, ['id', 'requirement']) && isUuid(item.id) && safeText(item.requirement, 500)) ||
      new Set(value.parameters.map(item => item.id)).size !== value.parameters.length) throw new LanguagePracticeClientError('invalid-response');
  const setup = value.setup as Record<string, unknown>;
  // Omitted historical difficulty is unknown; request defaults do not describe stored snapshots.
  return { ...value, setup: { ...setup, difficulty: isPracticeDifficulty(setup.difficulty) ? setup.difficulty : null } as ParsedPracticeSetup } as TeacherPractice;
}
export function parseCoverage(value: unknown): ParameterCoverage[] {
  if (!Array.isArray(value) || value.length > 20) throw new LanguagePracticeClientError('invalid-response');
  const items = value.map((item): ParameterCoverage => {
    if (!isRecord(item) || !hasExactKeys(item, ['parameterId', 'requirement', 'status', 'evidenceSequences', 'explanation']) ||
        !isUuid(item.parameterId) || !safeText(item.requirement, 500) || !safeText(item.explanation, 500) ||
        typeof item.status !== 'string' || !['met', 'partial', 'not-met', 'unassessed'].includes(item.status) || !Array.isArray(item.evidenceSequences) ||
        item.evidenceSequences.length > 256 || !item.evidenceSequences.every(n => Number.isSafeInteger(n) && n > 0) ||
        new Set(item.evidenceSequences).size !== item.evidenceSequences.length ||
        (['met', 'partial'].includes(item.status) && item.evidenceSequences.length === 0) ||
        (item.status === 'unassessed' && item.evidenceSequences.length !== 0)) throw new LanguagePracticeClientError('invalid-response');
    return item as ParameterCoverage;
  });
  if (new Set(items.map(item => item.parameterId)).size !== items.length) throw new LanguagePracticeClientError('invalid-response');
  // The report DTO cannot prove turn ownership/completion; the backend remains authoritative for evidence.
  return items;
}
