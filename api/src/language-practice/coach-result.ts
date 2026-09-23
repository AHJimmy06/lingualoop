export type CoachResult = {
  correctedPhrase: string
  feedback: string
  assistantResponse: string
}

export type CoachResultViolation =
  | 'raw_not_string'
  | 'raw_too_long'
  | 'invalid_json'
  | 'not_object'
  | 'wrong_shape'
  | 'field_invalid'
  | 'field_too_long'
  | 'fields_not_distinct'
  | 'field_content_duplicate'
  | 'assistant_response_language'
  | 'spanish_evidence_language'
  | 'correction_not_distinct'
  | 'correction_not_supported_by_transcript'
  | 'correction_change_not_identified'
  | 'proficiency_claim'
  | 'pronunciation_claim'
  | 'feedback_disallowed_content'
  | 'transcript_invalid'

export class InvalidCoachResultError extends Error {
  readonly violations: readonly CoachResultViolation[]

  constructor(violations: readonly CoachResultViolation[]) {
    super('Invalid coach result')
    this.name = 'InvalidCoachResultError'
    this.violations = [...new Set(violations)]
  }
}

const MAX_CORRECTED_PHRASE_LENGTH = 300
const MAX_FEEDBACK_LENGTH = 280
const MAX_ASSISTANT_RESPONSE_LENGTH = 500
const MAX_STRUCTURED_OUTPUT_LENGTH = 1_600
const MAX_TRANSCRIPT_LENGTH = 4_000

const englishMarkers = new Set([
  'the', 'and', 'are', 'was', 'were', 'have', 'has', 'with', 'from', 'your',
  'you', 'this', 'that', 'went', 'use',
])
const spanishMarkers = new Set([
  'el', 'la', 'los', 'las', 'una', 'que', 'para', 'con', 'por', 'del', 'fue',
  'ayer', 'viaje', 'usaste', 'pasado',
])
const grammarTerms = [
  'grammar', 'tense', 'past', 'present', 'future', 'verb', 'article',
  'preposition', 'agreement', 'word order', 'natural wording', 'gramática',
  'tiempo', 'pasado', 'presente', 'futuro', 'verbo', 'artículo',
  'preposición', 'concordancia', 'orden de las palabras', 'forma natural',
  'pretérito', 'artigo', 'preposição', 'concordância', 'ordem das palavras',
]
const noCorrectionPattern =
  /(?:no (?:correction|change)s? (?:was|were|is|are)? ?(?:needed|necessary)|already (?:correct|natural)|(?:sin|ning[uú]n(?:a)?) (?:correcci[oó]n|cambio)|no (?:fue|era|es) necesari[ao].*(?:correcci[oó]n|cambio)|(?:sem|nenhuma) (?:corre[cç][aã]o|altera[cç][aã]o)|n[aã]o (?:foi|era|é) necess[aá]ri[ao].*(?:corre[cç][aã]o|altera[cç][aã]o))/i
const disallowedFeedbackPattern =
  /\b(?:great job|well done|keep it up|excellent work|make sure to|remember to|buen trabajo|muy bien|sigue as[ií]|aseg[uú]rate de|recuerda|bom trabalho|muito bem|continue assim|certifique-se de|lembre-se de)\b/i
const unsupportedClaimPattern = /\b(?:A1|A2|B1|B2|C1|C2|CEFR)\b/i
const pronunciationPattern =
  /phonetic|pronunciation|pronunciaci[oó]n|fon[eé]tic|pron[uú]ncia/i

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokens(value: string): string[] {
  return normalize(value).split(' ').filter((token) => token.length > 2)
}

function hasClearLanguageSignal(
  value: string,
  expected: ReadonlySet<string>,
  opposite: ReadonlySet<string>,
): boolean {
  const valueTokens = tokens(value)
  const expectedCount = valueTokens.filter((token) => expected.has(token)).length
  const oppositeCount = valueTokens.filter((token) => opposite.has(token)).length
  return expectedCount >= 2 && expectedCount > oppositeCount
}

function hasExplicitNoCorrection(feedback: string): boolean {
  const normalized = normalize(feedback)
  const explicitPhrases = [
    'no correction was needed', 'no correction needed', 'no change was needed',
    'already correct', 'sin corrección', 'sin cambios', 'ya es correcta',
    'no necesitaba corrección', 'sem correção', 'sem alterações',
    'já está correta', 'não precisava de correção',
  ]
  return noCorrectionPattern.test(feedback) ||
    explicitPhrases.some((phrase) => normalized.includes(normalize(phrase)))
}

function correctionEvidenceIsConcrete(
  transcript: string,
  correctedPhrase: string,
  feedback: string,
): boolean {
  const feedbackNormalized = normalize(feedback)
  const sourceTokens = new Set(tokens(transcript))
  const correctionTokens = new Set(tokens(correctedPhrase))
  const changedTokens = [
    ...tokens(transcript).filter((token) => !correctionTokens.has(token)),
    ...tokens(correctedPhrase).filter((token) => !sourceTokens.has(token)),
  ]
  const namesAChange = changedTokens.some((token) => feedbackNormalized.includes(token))
  const namesGrammar = grammarTerms.some((term) =>
    feedbackNormalized.includes(normalize(term)),
  )
  return namesAChange || namesGrammar
}

function validate(value: unknown, transcript: string): CoachResultViolation[] {
  const violations: CoachResultViolation[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['not_object']

  const record = value as Record<string, unknown>
  const fields = ['correctedPhrase', 'feedback', 'assistantResponse'] as const
  const keys = Object.keys(record)
  if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) {
    return ['wrong_shape']
  }

  if (fields.some((field) => typeof record[field] !== 'string' || !record[field].trim())) {
    return ['field_invalid']
  }

  const correctedPhrase = (record.correctedPhrase as string).trim()
  const feedback = (record.feedback as string).trim()
  const assistantResponse = (record.assistantResponse as string).trim()
  if (correctedPhrase.length > MAX_CORRECTED_PHRASE_LENGTH ||
      feedback.length > MAX_FEEDBACK_LENGTH ||
      assistantResponse.length > MAX_ASSISTANT_RESPONSE_LENGTH) {
    violations.push('field_too_long')
  }

  const normalizedFields = [correctedPhrase, feedback, assistantResponse].map(normalize)
  if (new Set(normalizedFields).size !== fields.length) violations.push('fields_not_distinct')
  if (normalizedFields.some((field, index) => normalizedFields.some(
    (other, otherIndex) => index !== otherIndex && field.length > 12 && other.includes(field),
  ))) violations.push('field_content_duplicate')

  if (hasClearLanguageSignal(assistantResponse, spanishMarkers, englishMarkers)) {
    violations.push('assistant_response_language')
  }
  for (const evidence of [correctedPhrase, feedback]) {
    if (hasClearLanguageSignal(evidence, englishMarkers, spanishMarkers)) {
      violations.push('spanish_evidence_language')
      break
    }
  }

  if (normalize(correctedPhrase) === normalize(assistantResponse)) {
    violations.push('correction_not_distinct')
  }
  const noChange = hasExplicitNoCorrection(feedback)
  if (!noChange && !correctionEvidenceIsConcrete(transcript, correctedPhrase, feedback)) {
    violations.push('correction_not_supported_by_transcript')
    violations.push('correction_change_not_identified')
  }

  const combinedOutput = `${correctedPhrase}\n${feedback}\n${assistantResponse}`
  if (unsupportedClaimPattern.test(combinedOutput)) violations.push('proficiency_claim')
  if (pronunciationPattern.test(combinedOutput)) violations.push('pronunciation_claim')
  if (disallowedFeedbackPattern.test(feedback)) violations.push('feedback_disallowed_content')
  return violations
}

/** Parses bounded, untrusted model output into the exact public coach result shape. */
export function parseCoachResult(raw: string, transcript: string): CoachResult {
  if (typeof raw !== 'string') throw new InvalidCoachResultError(['raw_not_string'])
  if (raw.length > MAX_STRUCTURED_OUTPUT_LENGTH) {
    throw new InvalidCoachResultError(['raw_too_long'])
  }
  if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > MAX_TRANSCRIPT_LENGTH) {
    throw new InvalidCoachResultError(['transcript_invalid'])
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new InvalidCoachResultError(['invalid_json'])
  }
  const violations = validate(parsed, transcript)
  if (violations.length) throw new InvalidCoachResultError(violations)

  const result = parsed as CoachResult
  return {
    correctedPhrase: result.correctedPhrase.trim(),
    feedback: result.feedback.trim(),
    assistantResponse: result.assistantResponse.trim(),
  }
}
