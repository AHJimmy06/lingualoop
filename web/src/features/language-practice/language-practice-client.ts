import type { AuthSession } from '../../auth-session'
const LANGUAGE_PRACTICE_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
const LANGUAGE_PRACTICE_DURATIONS = [5, 10, 15] as const
const LANGUAGE_PRACTICE_TOPICS = ['travel', 'work', 'studies', 'everyday-conversation'] as const
type LanguagePracticeLevel = (typeof LANGUAGE_PRACTICE_LEVELS)[number]
type LanguagePracticeDuration = (typeof LANGUAGE_PRACTICE_DURATIONS)[number]
type LanguagePracticeTopic = (typeof LANGUAGE_PRACTICE_TOPICS)[number]
type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'COMPLETED'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_AUDIO_BYTES = 8 * 1024 * 1024
const MAX_COMPLETED_TURNS = 256
const MAX_DETAIL_TEXT_LENGTH = 2000
// The immediate turn response keeps the coach's 4,000-character transcript; session history is clipped to 2,000.
const MAX_TURN_TRANSCRIPT_LENGTH = 4000
const ACCEPTED_AUDIO_TYPES = new Set([
  'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus',
  'audio/wav', 'audio/x-wav', 'audio/mp4',
])

type RecordValue = Record<string, unknown>
export type PracticeSetup = {
  level: LanguagePracticeLevel
  topic: LanguagePracticeTopic
  durationMinutes: LanguagePracticeDuration
}
export type SessionTurn = { sequence: number; transcript: string; assistantResponse: string; completedAt: string }
export type FinishSessionResponse = { id: string; status: 'COMPLETED' | 'EXPIRED' }
export type SessionDetail = {
  id: string
  status: SessionStatus
  level: LanguagePracticeLevel
  topic: LanguagePracticeTopic
  durationMinutes: LanguagePracticeDuration
  startedAt: string
  expiresAt: string
  remainingMs: number
  turnInProgress: false
  turns: SessionTurn[]
}
export type LanguagePracticeTurnResponse = {
  id: string
  clientTurnId: string
  sequence: number
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED'
  transcript: string | null
  assistantResponse: string | null
  completedAt: string | null
  audioBase64: string | null
  audioMimeType: 'audio/wav' | null
  session: SessionDetail
}
type LanguagePracticeReportCorrection = {
  sequence: number
  original: string
  correctedPhrase: string
  explanation: string
}
export type LanguagePracticeReport = {
  sessionId: string
  summary: string
  corrections: LanguagePracticeReportCorrection[]
  strengths: string[]
  recommendations: string[]
  generatedWithAi: boolean
  createdAt: string
}

export type LanguagePracticeClientErrorKind =
  | 'unauthenticated'
  | 'not-found'
  | 'conflict'
  | 'unavailable'
  | 'invalid-response'
  | 'invalid-input'

export class LanguagePracticeClientError extends Error {
  constructor(readonly kind: LanguagePracticeClientErrorKind, readonly status: number | null = null) {
    super(publicMessage(kind))
    this.name = 'LanguagePracticeClientError'
  }
}

function publicMessage(kind: LanguagePracticeClientErrorKind): string {
  switch (kind) {
    case 'unauthenticated': return 'Sign in to continue.'
    case 'not-found': return 'This practice session could not be found.'
    case 'conflict': return 'This practice action is not available right now.'
    case 'invalid-input': return 'The practice request is invalid.'
    case 'invalid-response': return 'The practice service returned an invalid response.'
    default: return 'The practice service is temporarily unavailable.'
  }
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || Boolean(value.trim()))
}

function parseSession(value: unknown): SessionDetail {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'status', 'level', 'topic', 'durationMinutes', 'startedAt', 'expiresAt', 'remainingMs', 'turnInProgress', 'turns',
  ]) || !isUuid(value.id) ||
      !LANGUAGE_PRACTICE_LEVELS.includes(value.level as LanguagePracticeLevel) ||
      !LANGUAGE_PRACTICE_TOPICS.includes(value.topic as LanguagePracticeTopic) ||
      !LANGUAGE_PRACTICE_DURATIONS.includes(value.durationMinutes as LanguagePracticeDuration) ||
      !['ACTIVE', 'EXPIRED', 'COMPLETED'].includes(String(value.status)) ||
      !isTimestamp(value.startedAt) || !isTimestamp(value.expiresAt) ||
      typeof value.remainingMs !== 'number' || !Number.isSafeInteger(value.remainingMs) || value.remainingMs < 0 ||
      value.turnInProgress !== false || !Array.isArray(value.turns) || value.turns.length > MAX_COMPLETED_TURNS) {
    throw new LanguagePracticeClientError('invalid-response')
  }
  const turns = value.turns.map((turn): SessionTurn => {
    if (!isRecord(turn) || !hasExactKeys(turn, ['sequence', 'transcript', 'assistantResponse', 'completedAt']) ||
        typeof turn.sequence !== 'number' || !Number.isSafeInteger(turn.sequence) || turn.sequence < 1 ||
        !boundedText(turn.transcript, MAX_DETAIL_TEXT_LENGTH, true) || !boundedText(turn.assistantResponse, MAX_DETAIL_TEXT_LENGTH, true) ||
        !isTimestamp(turn.completedAt)) {
      throw new LanguagePracticeClientError('invalid-response')
    }
    return {
      sequence: turn.sequence,
      transcript: turn.transcript,
      assistantResponse: turn.assistantResponse,
      completedAt: turn.completedAt,
    }
  })
  return {
    id: value.id,
    status: value.status as SessionStatus,
    level: value.level as LanguagePracticeLevel,
    topic: value.topic as LanguagePracticeTopic,
    durationMinutes: value.durationMinutes as LanguagePracticeDuration,
    startedAt: value.startedAt,
    expiresAt: value.expiresAt,
    remainingMs: value.remainingMs,
    turnInProgress: false,
    turns,
  }
}

function isBoundedBase64(value: unknown): value is string {
  const maximumLength = Math.ceil(MAX_RESPONSE_AUDIO_BYTES / 3) * 4
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const content = padding ? value.slice(0, -padding) : value
  if (!content || content.includes('=') || /[^A-Za-z0-9+/]/.test(content)) return false
  if ((padding === 2 && content.length % 4 !== 2) || (padding === 1 && content.length % 4 !== 3)) return false
  const decodedBytes = value.length / 4 * 3 - padding
  return decodedBytes > 0 && decodedBytes <= MAX_RESPONSE_AUDIO_BYTES
}

function parseTurn(value: unknown): LanguagePracticeTurnResponse {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'clientTurnId', 'sequence', 'status', 'transcript', 'assistantResponse', 'completedAt',
    'audioBase64', 'audioMimeType', 'session',
  ]) || !isUuid(value.id) || !isUuid(value.clientTurnId) ||
      typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !['PROCESSING', 'COMPLETED', 'FAILED'].includes(String(value.status)) ||
      !(value.transcript === null || boundedText(value.transcript, MAX_TURN_TRANSCRIPT_LENGTH, true)) ||
      !(value.assistantResponse === null || boundedText(value.assistantResponse, MAX_DETAIL_TEXT_LENGTH, true)) ||
      !(value.completedAt === null || isTimestamp(value.completedAt))) {
    throw new LanguagePracticeClientError('invalid-response')
  }
  const hasAudio = isBoundedBase64(value.audioBase64) && value.audioMimeType === 'audio/wav'
  const hasNoAudio = value.audioBase64 === null && value.audioMimeType === null
  if ((!hasAudio && !hasNoAudio) || !isBoundedBase64(value.audioBase64) && value.audioBase64 !== null) {
    throw new LanguagePracticeClientError('invalid-response')
  }
  return {
    id: value.id,
    clientTurnId: value.clientTurnId,
    sequence: value.sequence,
    status: value.status as LanguagePracticeTurnResponse['status'],
    transcript: value.transcript as string | null,
    assistantResponse: value.assistantResponse as string | null,
    completedAt: value.completedAt as string | null,
    audioBase64: value.audioBase64 as string | null,
    audioMimeType: value.audioMimeType as 'audio/wav' | null,
    session: parseSession(value.session),
  }
}

function parseFinish(value: unknown, expectedSessionId: string): FinishSessionResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'status']) || value.id !== expectedSessionId ||
      !isUuid(value.id) || (value.status !== 'COMPLETED' && value.status !== 'EXPIRED')) {
    throw new LanguagePracticeClientError('invalid-response')
  }
  return { id: value.id, status: value.status }
}

function parseReport(value: unknown, expectedSessionId: string): LanguagePracticeReport {
  if (!isRecord(value) || !hasExactKeys(value, [
    'sessionId', 'summary', 'corrections', 'strengths', 'recommendations', 'generatedWithAi', 'createdAt',
  ]) || value.sessionId !== expectedSessionId || typeof value.generatedWithAi !== 'boolean' || !isTimestamp(value.createdAt) ||
      !boundedText(value.summary, 400) || !Array.isArray(value.corrections) || value.corrections.length > 20 ||
      !Array.isArray(value.strengths) || value.strengths.length > 3 ||
      !Array.isArray(value.recommendations) || value.recommendations.length > 3) {
    throw new LanguagePracticeClientError('invalid-response')
  }
  const corrections = value.corrections.map((correction): LanguagePracticeReportCorrection => {
    if (!isRecord(correction) || !hasExactKeys(correction, ['sequence', 'original', 'correctedPhrase', 'explanation']) ||
        typeof correction.sequence !== 'number' || !Number.isSafeInteger(correction.sequence) || correction.sequence < 1 ||
        !boundedText(correction.original, 500) || !boundedText(correction.correctedPhrase, 300) ||
        !boundedText(correction.explanation, 280)) {
      throw new LanguagePracticeClientError('invalid-response')
    }
    return {
      sequence: correction.sequence,
      original: correction.original,
      correctedPhrase: correction.correctedPhrase,
      explanation: correction.explanation,
    }
  })
  const parseTextList = (items: unknown[]): string[] => items.map((item) => {
    if (!boundedText(item, 400)) throw new LanguagePracticeClientError('invalid-response')
    return item
  })
  return {
    sessionId: expectedSessionId,
    summary: value.summary,
    corrections,
    strengths: parseTextList(value.strengths),
    recommendations: parseTextList(value.recommendations),
    generatedWithAi: value.generatedWithAi,
    createdAt: value.createdAt,
  }
}

function responseError(status: number): LanguagePracticeClientError {
  if (status === 401) return new LanguagePracticeClientError('unauthenticated', status)
  if (status === 404) return new LanguagePracticeClientError('not-found', status)
  if (status === 409) return new LanguagePracticeClientError('conflict', status)
  if (status === 503) return new LanguagePracticeClientError('unavailable', status)
  return new LanguagePracticeClientError('unavailable', status)
}

export class LanguagePracticeClient {
  constructor(private readonly session: AuthSession) {}

  async createSession(setup: PracticeSetup): Promise<SessionDetail> {
    this.validateSetup(setup)
    const response = await this.post('/api/language-practice/sessions', setup)
    return parseSession(await this.readJson(response))
  }

  async getSession(sessionId: string): Promise<SessionDetail> {
    this.validateUuid(sessionId)
    const response = await this.session.getWithRefresh(`/api/language-practice/sessions/${sessionId}`)
    if (!response) throw new LanguagePracticeClientError('unavailable')
    if (!response.ok) throw responseError(response.status)
    return parseSession(await this.readJson(response))
  }

  async submitTurn(sessionId: string, audio: Blob, clientTurnId: string): Promise<LanguagePracticeTurnResponse> {
    this.validateUuid(sessionId)
    this.validateUuid(clientTurnId)
    if (!(audio instanceof Blob) || audio.size === 0 || audio.size > MAX_UPLOAD_BYTES || !ACCEPTED_AUDIO_TYPES.has(audio.type)) {
      throw new LanguagePracticeClientError('invalid-input')
    }
    const form = new FormData()
    const extension = audio.type.includes('ogg') ? 'ogg' : audio.type.includes('wav') ? 'wav' : audio.type.includes('mp4') ? 'mp4' : 'webm'
    form.append('audio', audio, `turn.${extension}`)
    form.append('clientTurnId', clientTurnId)
    const response = await this.post(`/api/language-practice/sessions/${sessionId}/turns`, form)
    const result = parseTurn(await this.readJson(response))
    if (result.clientTurnId !== clientTurnId) throw new LanguagePracticeClientError('invalid-response')
    return result
  }

  async finishSession(sessionId: string): Promise<FinishSessionResponse> {
    this.validateUuid(sessionId)
    const response = await this.post(`/api/language-practice/sessions/${sessionId}/finish`, {})
    return parseFinish(await this.readJson(response), sessionId)
  }

  async getOrCreateReport(sessionId: string): Promise<LanguagePracticeReport> {
    this.validateUuid(sessionId)
    const response = await this.post(`/api/language-practice/sessions/${sessionId}/report`, {})
    return parseReport(await this.readJson(response), sessionId)
  }

  private async post(path: string, body: Record<string, unknown> | FormData): Promise<Response> {
    const response = await this.session.postLanguagePractice(path, body)
    if (!response) throw new LanguagePracticeClientError('unavailable')
    if (!response.ok) throw responseError(response.status)
    return response
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw new LanguagePracticeClientError('invalid-response', response.status)
    }
  }

  private validateUuid(value: string): void {
    if (!isUuid(value)) throw new LanguagePracticeClientError('invalid-input')
  }

  private validateSetup(setup: PracticeSetup): void {
    if (!setup || typeof setup !== 'object' ||
        !LANGUAGE_PRACTICE_LEVELS.includes(setup.level) ||
        !LANGUAGE_PRACTICE_TOPICS.includes(setup.topic) ||
        !LANGUAGE_PRACTICE_DURATIONS.includes(setup.durationMinutes)) {
      throw new LanguagePracticeClientError('invalid-input')
    }
  }
}
