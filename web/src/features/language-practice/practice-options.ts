import type { AuthSession } from '../../auth-session'

export type PracticeOption = { code: string; label: string }

const SUPPORTED_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
const SUPPORTED_DURATIONS = [5, 10, 15]
const SUPPORTED_TOPICS = ['travel', 'work', 'studies', 'everyday-conversation']
const SUPPORTED_OUTPUT_LANGUAGES = ['en', 'es']
export type PracticeOptions = {
  levels: string[]
  durationsMinutes: number[]
  inputLanguage: PracticeOption
  outputLanguages: PracticeOption[]
  topics: PracticeOption[]
  acceptedMimeTypes: string[]
  maxFileSizeBytes: number
  maxDurationMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOption(value: unknown): value is PracticeOption {
  return isRecord(value) && typeof value.code === 'string' && value.code.trim().length > 0 &&
    typeof value.label === 'string' && value.label.trim().length > 0
}

function hasUniqueOptions(options: unknown[]): options is PracticeOption[] {
  if (!options.every(isOption)) return false
  const codes = options.map((option) => option.code.trim())
  const labels = options.map((option) => option.label.trim().toLocaleLowerCase())
  return new Set(codes).size === options.length && new Set(labels).size === options.length
}

function sameValues(actual: unknown[], expected: readonly (string | number)[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

export function parsePracticeOptions(value: unknown): PracticeOptions | null {
  if (!isRecord(value) || !isOption(value.inputLanguage)) return null
  const { levels, durationsMinutes, outputLanguages, topics, acceptedMimeTypes, maxFileSizeBytes, maxDurationMs } = value
  if (!Array.isArray(levels) || !sameValues(levels, SUPPORTED_LEVELS)) return null
  if (!Array.isArray(durationsMinutes) || !sameValues(durationsMinutes, SUPPORTED_DURATIONS)) return null
  if (!isOption(value.inputLanguage) || value.inputLanguage.code !== 'en') return null
  if (!Array.isArray(outputLanguages) || !hasUniqueOptions(outputLanguages) ||
      !sameValues(outputLanguages.map((option) => option.code), SUPPORTED_OUTPUT_LANGUAGES)) return null
  if (!Array.isArray(topics) || !hasUniqueOptions(topics) ||
      !sameValues(topics.map((option) => option.code), SUPPORTED_TOPICS)) return null
  if (!Array.isArray(acceptedMimeTypes) || !acceptedMimeTypes.length ||
      !acceptedMimeTypes.every((item) => typeof item === 'string' && item.trim().length > 0) ||
      new Set(acceptedMimeTypes.map((item) => item.trim().toLowerCase())).size !== acceptedMimeTypes.length) return null
  if (typeof maxFileSizeBytes !== 'number' || !Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes <= 0) return null
  if (typeof maxDurationMs !== 'number' || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) return null
  return value as PracticeOptions
}

export async function fetchPracticeOptions(session: AuthSession): Promise<PracticeOptions> {
  const response = await session.getWithRefresh('/api/language-practice/options')
  if (!response || !response.ok) throw new Error('Practice options are currently unavailable.')
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('Practice options are currently unavailable.')
  }
  const options = parsePracticeOptions(body)
  if (!options) throw new Error('Practice options are currently unavailable.')
  return options
}
