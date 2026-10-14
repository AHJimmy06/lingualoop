import { UUID_PATTERN } from '../auth/profile';
import { LANGUAGE_PRACTICE_LEVELS, LANGUAGE_PRACTICE_DURATIONS, LANGUAGE_PRACTICE_DIFFICULTIES, type PracticeSetup, type PracticeDifficulty } from './language-practice-client';
export type PracticePreferences = Pick<PracticeSetup, 'level' | 'durationMinutes'> & { difficulty: PracticeDifficulty };
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
const fallback: PracticePreferences = { level: 'A1', durationMinutes: 5, difficulty: 'medium' };
export function difficultyLabel(value: PracticeDifficulty | null | undefined): string {
  return value === 'easy' ? 'Easy' : value === 'medium' ? 'Medium' : value === 'hard' ? 'Hard' : 'Difficulty not recorded';
}
function valid(value: unknown, allowLegacy = false): value is PracticePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const legacy = allowLegacy && Object.keys(record).length === 2 && !('difficulty' in record);
  return (legacy || (Object.keys(record).length === 3 && LANGUAGE_PRACTICE_DIFFICULTIES.includes(record.difficulty as PracticeDifficulty))) &&
    LANGUAGE_PRACTICE_LEVELS.includes(record.level as PracticeSetup['level']) &&
    LANGUAGE_PRACTICE_DURATIONS.includes(record.durationMinutes as PracticeSetup['durationMinutes']);
}
function key(ownerId: string): string { return `lingualoop:default-preferences:${ownerId}`; }
export function readPreferences(ownerId: string, storage?: PreferenceStorage): PracticePreferences {
  if (!UUID_PATTERN.test(ownerId)) return { ...fallback };
  try {
    const value: unknown = JSON.parse((storage ?? globalThis.localStorage).getItem(key(ownerId)) ?? 'null');
    // Compatibility applies only to future default starts, never saved practice/session DTOs.
    return valid(value, true) ? { level: value.level, durationMinutes: value.durationMinutes, difficulty: value.difficulty ?? 'medium' } : { ...fallback };
  } catch { return { ...fallback }; }
}
export function savePreferences(ownerId: string, value: PracticePreferences, storage?: PreferenceStorage): boolean {
  if (!UUID_PATTERN.test(ownerId) || !valid(value)) return false;
  try { (storage ?? globalThis.localStorage).setItem(key(ownerId), JSON.stringify(value)); return true; }
  catch { return false; }
}
