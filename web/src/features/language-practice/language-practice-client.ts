import type { AuthSession } from '../../auth-session'
import { isValidSetup, hasSetupKeys, isPracticeDifficulty, hasResponseDifficulty, parseCoverage, parsePractice, validateCreatePractice, validatePracticeImage, MAX_PRACTICE_IMAGE_BYTES } from './practice-contract'
export const LANGUAGE_PRACTICE_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
export const LANGUAGE_PRACTICE_DURATIONS = [5, 10, 15] as const
export const LANGUAGE_PRACTICE_TOPICS = ['travel', 'work', 'studies', 'everyday-conversation'] as const
export const LANGUAGE_PRACTICE_DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export type PracticeDifficulty = (typeof LANGUAGE_PRACTICE_DIFFICULTIES)[number]
type LanguagePracticeLevel = (typeof LANGUAGE_PRACTICE_LEVELS)[number]
type LanguagePracticeDuration = (typeof LANGUAGE_PRACTICE_DURATIONS)[number]
type LanguagePracticeTopic = (typeof LANGUAGE_PRACTICE_TOPICS)[number]
type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'COMPLETED'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_AUDIO_BYTES = 8 * 1024 * 1024
const MAX_COMPLETED_TURNS = 256
const MAX_DETAIL_TEXT_LENGTH = 2000
// React StrictMode may run the report-loading effect twice in development. Share the
// same POST while it is pending so the API's durable generation claim is not mistaken
// for a report failure by the second mount.
const pendingReportRequests = new Map<string, Promise<LanguagePracticeReport>>()
const pendingSupportRequests = new Map<string, Promise<ReportLearningSupport>>()
// The immediate turn response keeps the coach's 4,000-character transcript; session history is clipped to 2,000.
const MAX_TURN_TRANSCRIPT_LENGTH = 4000
const ACCEPTED_AUDIO_TYPES = new Set([
  'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus',
  'audio/wav', 'audio/x-wav', 'audio/mp4',
])

type RecordValue = Record<string, unknown>
export type PracticeSetup = {
  difficulty?: PracticeDifficulty
  level: LanguagePracticeLevel
  topic: LanguagePracticeTopic
  durationMinutes: LanguagePracticeDuration
}
export type ParsedPracticeSetup = Omit<PracticeSetup, 'difficulty'> & { difficulty: PracticeDifficulty | null }
export type SessionTurn = { sequence: number; transcript: string; assistantResponse: string; completedAt: string }
export type FinishSessionResponse = { id: string; status: 'COMPLETED' | 'EXPIRED' }
export type SessionDetail = {
  id: string
  status: SessionStatus
  difficulty: PracticeDifficulty | null
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
export type ParameterCoverage = {
  parameterId: string
  requirement: string
  status: 'met' | 'partial' | 'not-met' | 'unassessed'
  evidenceSequences: number[]
  explanation: string
}
export type TeacherPractice = {
  id: string; teacherId: string; teacherName: string; title: string; setup: ParsedPracticeSetup
  parameters: { id: string; requirement: string }[]; createdAt: string; hasImage: boolean
}
export type CreatePractice = { title: string; setup: Omit<PracticeSetup, 'topic'>; parameters: { requirement: string }[] }
export type LanguagePracticeReport = {
  parameterCoverage: ParameterCoverage[]
  sessionId: string
  summary: string
  corrections: LanguagePracticeReportCorrection[]
  strengths: string[]
  recommendations: string[]
  generatedWithAi: boolean
  createdAt: string
}

export type ReportLearningNote = { textEn: string; textEs: string; evidenceSequences: number[] }
export type ReportLearningSupport = {
  corrections: { sequence: number; suggestedEnglish: string; translationEs: string; explanationEn: string; explanationEs: string }[]
  strengths: ReportLearningNote[]
  recommendations: ReportLearningNote[]
}

export function parseReportLearningSupport(value: unknown): ReportLearningSupport {
  if (!isRecord(value) || !hasExactKeys(value, ['corrections', 'strengths', 'recommendations']) ||
      !Array.isArray(value.corrections) || value.corrections.length > 20) throw new LanguagePracticeClientError('invalid-response')
  const corrections = value.corrections.map(item => {
    if (!isRecord(item) || !hasExactKeys(item, ['sequence', 'suggestedEnglish', 'translationEs', 'explanationEn', 'explanationEs']) ||
        !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1 ||
        !boundedText(item.suggestedEnglish, 500) || !boundedText(item.translationEs, 500) ||
        !boundedText(item.explanationEn, 500) || !boundedText(item.explanationEs, 500)) throw new LanguagePracticeClientError('invalid-response')
    return { sequence: item.sequence as number, suggestedEnglish: item.suggestedEnglish, translationEs: item.translationEs, explanationEn: item.explanationEn, explanationEs: item.explanationEs }
  })
  if (new Set(corrections.map(item => item.sequence)).size !== corrections.length) throw new LanguagePracticeClientError('invalid-response')
  const notes = (items: unknown): ReportLearningNote[] => {
    if (!Array.isArray(items) || items.length > 3) throw new LanguagePracticeClientError('invalid-response')
    return items.map(item => {
      if (!isRecord(item) || !hasExactKeys(item, ['textEn', 'textEs', 'evidenceSequences']) ||
          !boundedText(item.textEn, 500) || !boundedText(item.textEs, 500) || !Array.isArray(item.evidenceSequences) || item.evidenceSequences.length > 256 ||
          item.evidenceSequences.some(seq => !Number.isSafeInteger(seq) || seq < 1) || new Set(item.evidenceSequences).size !== item.evidenceSequences.length) throw new LanguagePracticeClientError('invalid-response')
      return { textEn: item.textEn, textEs: item.textEs, evidenceSequences: item.evidenceSequences as number[] }
    })
  }
  return { corrections, strengths: notes(value.strengths), recommendations: notes(value.recommendations) }
}

export type LanguagePracticeClientErrorKind =
  | 'unauthenticated'
  | 'forbidden'
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
    case 'forbidden': return 'Your account does not have permission for this action.'
    case 'not-found': return 'This practice session could not be found.'
    case 'conflict': return 'This practice action is not available right now.'
    case 'invalid-input': return 'The practice request is invalid.'
    case 'invalid-response': return 'The practice service returned an invalid response.'
    default: return 'The practice service is temporarily unavailable.'
  }
}

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
}

export function boundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || Boolean(value.trim()))
}

function parseSession(value: unknown): SessionDetail {
  if (!isRecord(value) || !hasSetupKeys(value, [
    'id', 'status', 'level', 'topic', 'durationMinutes', 'startedAt', 'expiresAt', 'remainingMs', 'turnInProgress', 'turns',
  ]) || !hasResponseDifficulty(value) || !isUuid(value.id) ||
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
    difficulty: isPracticeDifficulty(value.difficulty) ? value.difficulty : null,
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

export function parseReport(value: unknown, expectedSessionId: string): LanguagePracticeReport {
  if (!isRecord(value) || !hasExactKeys(value, [
    'sessionId', 'summary', 'corrections', 'strengths', 'recommendations', 'generatedWithAi', 'createdAt', 'parameterCoverage',
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
    parameterCoverage: parseCoverage(value.parameterCoverage),
    summary: value.summary,
    corrections,
    strengths: parseTextList(value.strengths),
    recommendations: parseTextList(value.recommendations),
    generatedWithAi: value.generatedWithAi,
    createdAt: value.createdAt,
  }
}

export function responseError(status: number): LanguagePracticeClientError {
  if (status === 403) return new LanguagePracticeClientError('forbidden', status)
  if (status === 400) return new LanguagePracticeClientError('invalid-input', status)
  if (status === 401) return new LanguagePracticeClientError('unauthenticated', status)
  if (status === 404) return new LanguagePracticeClientError('not-found', status)
  if (status === 409) return new LanguagePracticeClientError('conflict', status)
  if (status === 503) return new LanguagePracticeClientError('unavailable', status)
  return new LanguagePracticeClientError('unavailable', status)
}

export class LanguagePracticeClient {
  constructor(private readonly session: AuthSession) {}

  async listPractices(): Promise<TeacherPractice[]> {
    const value = await this.getJson('/api/language-practice/practices')
    if (!isRecord(value) || !hasExactKeys(value, ['practices']) || !Array.isArray(value.practices)) throw new LanguagePracticeClientError('invalid-response')
    const practices = value.practices.map(parsePractice)
    if (new Set(practices.map(item => item.id)).size !== practices.length) throw new LanguagePracticeClientError('invalid-response')
    return practices
  }

  async getPractice(id: string): Promise<TeacherPractice> {
    this.validateUuid(id)
    const practice = parsePractice(await this.getJson(`/api/language-practice/practices/${id}`))
    if (practice.id !== id) throw new LanguagePracticeClientError('invalid-response')
    return practice
  }

  async createPractice(input: CreatePractice, image?: Blob): Promise<TeacherPractice> {
    validateCreatePractice(input)
    if (image === undefined) return parsePractice(await this.readJson(await this.post('/api/language-practice/practices', input)))
    validatePracticeImage(image)
    const body = new FormData()
    body.append('metadata', JSON.stringify(input))
    body.append('image', image, 'cover')
    return parsePractice(await this.readJson(await this.post('/api/language-practice/practices', body)))
  }

  async getPracticeImage(id: string): Promise<Blob> {
    this.validateUuid(id)
    const response = await this.session.getWithRefresh(`/api/language-practice/practices/${id}/image`)
    if (!response) throw new LanguagePracticeClientError(this.session.authenticated ? 'unavailable' : 'unauthenticated')
    if (response.status !== 200) throw responseError(response.status)
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'image/jpeg' ||
        Number(response.headers.get('content-length')) > MAX_PRACTICE_IMAGE_BYTES || !response.body) throw new LanguagePracticeClientError('invalid-response')
    const reader = response.body.getReader()
    const chunks: ArrayBuffer[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_PRACTICE_IMAGE_BYTES) { await reader.cancel(); throw new LanguagePracticeClientError('invalid-response') }
        chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
      }
    } catch (error) {
      if (error instanceof LanguagePracticeClientError) throw error
      throw new LanguagePracticeClientError('unavailable')
    } finally { reader.releaseLock() }
    if (size === 0) throw new LanguagePracticeClientError('invalid-response')
    return new Blob(chunks, { type: 'image/jpeg' })
  }

  async createCustomSession(input: { practiceId: string }): Promise<SessionDetail> {
    if (!isRecord(input) || !hasExactKeys(input, ['practiceId']) || !isUuid(input.practiceId)) throw new LanguagePracticeClientError('invalid-input')
    return parseSession(await this.readJson(await this.post('/api/language-practice/sessions', input)))
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.session.getWithRefresh(path)
    if (!response) throw new LanguagePracticeClientError('unavailable')
    if (!response.ok) throw responseError(response.status)
    return this.readJson(response)
  }

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

  getOrCreateReport(sessionId: string): Promise<LanguagePracticeReport> {
    this.validateUuid(sessionId)
    const pending = pendingReportRequests.get(sessionId)
    if (pending) return pending

    const request = this.post(`/api/language-practice/sessions/${sessionId}/report`, {})
      .then(async response => parseReport(await this.readJson(response), sessionId))
    pendingReportRequests.set(sessionId, request)
    const clear = () => {
      if (pendingReportRequests.get(sessionId) === request) pendingReportRequests.delete(sessionId)
    }
    void request.then(clear, clear)
    return request
  }

  async getCachedReportLearningSupport(sessionId: string): Promise<ReportLearningSupport | null> {
    this.validateUuid(sessionId)
    const response = await this.session.getWithRefresh(`/api/language-practice/sessions/${sessionId}/report/learning-support`)
    if (!response) throw new LanguagePracticeClientError('unavailable')
    if (response.status === 204) return null
    if (!response.ok) throw responseError(response.status)
    return parseReportLearningSupport(await this.readJson(response))
  }

  prepareReportLearningSupport(sessionId: string): Promise<ReportLearningSupport> {
    this.validateUuid(sessionId)
    const pending = pendingSupportRequests.get(sessionId)
    if (pending) return pending
    const request = this.post(`/api/language-practice/sessions/${sessionId}/report/learning-support`, {})
      .then(async response => parseReportLearningSupport(await this.readJson(response)))
    pendingSupportRequests.set(sessionId, request)
    const clear = () => { if (pendingSupportRequests.get(sessionId) === request) pendingSupportRequests.delete(sessionId) }
    void request.then(clear, clear)
    return request
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
    if (!isValidSetup(setup)) {
      throw new LanguagePracticeClientError('invalid-input')
    }
  }
}
