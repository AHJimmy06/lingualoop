import { buildCoachPromptMessages, type CoachPromptInput } from './coach-prompt'
import { InvalidCoachResultError, parseCoachResult, type CoachResult } from './coach-result'
import { APIError, APIConnectionError, APIConnectionTimeoutError } from 'openai'

export type CoachDiagnostic = { component: 'coach'; phase: 'request'; code: 'output_validation' | 'output_incomplete' | 'output_refusal' | 'output_envelope' | 'provider_error' | 'provider_timeout' | 'provider_connection' | 'provider_http'; providerStatus?: number }
const coachDiagnostics = new WeakMap<object, CoachDiagnostic>()
export function getCoachDiagnostic(error: unknown): CoachDiagnostic | undefined {
  if (!error || typeof error !== 'object') return undefined
  const detail = coachDiagnostics.get(error)
  return detail ? { ...detail } : undefined
}

export type CoachResponsesRequest = {
  model: string
  input: ReturnType<typeof buildCoachPromptMessages>
  max_output_tokens: 1200
  reasoning: { effort: 'none' }
  store: false
  text: {
    format: {
      type: 'json_schema'
      name: 'language_practice_coaching'
      strict: true
      schema: typeof coachSchema
    }
  }
}

export interface CoachResponsesClient {
  responses: {
    create(request: CoachResponsesRequest): Promise<unknown>
  }
}

export class CoachAdapterUnavailableError extends Error {
  constructor() {
    super('The conversation coach is temporarily unavailable')
    this.name = 'CoachAdapterUnavailableError'
  }
}

const MAX_STRUCTURED_OUTPUT_LENGTH = 1_600
const MAX_ASSISTANT_RESPONSE_LENGTH = 500

const coachSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    correctedPhrase: {
      type: 'string',
      minLength: 1,
      maxLength: 300,
      description:
        "A concise Spanish correction of the learner's utterance that preserves its meaning; state the Spanish equivalent when no correction is needed.",
    },
    feedback: {
      type: 'string',
      minLength: 1,
      maxLength: 280,
      description:
        'One concise Spanish explanation of the specific grammar or natural-wording change, or an explicit Spanish statement that no correction was needed; never advice or encouragement.',
    },
    assistantResponse: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_ASSISTANT_RESPONSE_LENGTH,
      description:
        'A warm, developed spoken English reply, usually 3–5 connected sentences within 500 characters: first answer or react specifically to the learner, add a relevant observation or detail, then always end with exactly one naturally connected question, the only question in the response. Use history and CEFR-appropriate language. Not an interview, quiz, checklist or lecture; do not repeat the Spanish evidence.',
    },
  },
  required: ['correctedPhrase', 'feedback', 'assistantResponse'],
} as const

/** One-call, inert adapter: provider construction and model selection belong to its caller. */
export class CoachAdapter {
  constructor(
    private readonly client: CoachResponsesClient,
    private readonly model: string,
  ) {
    if (!client || typeof client.responses?.create !== 'function') {
      throw new TypeError('an injected Responses API client is required')
    }
    if (typeof model !== 'string' || !model.trim()) {
      throw new TypeError('a model identifier is required')
    }
  }

  async respond(input: CoachPromptInput): Promise<CoachResult> {
    let code: CoachDiagnostic['code'] = 'provider_error'
    try {
      const response = await this.client.responses.create({
        model: this.model,
        input: buildCoachPromptMessages(input),
        max_output_tokens: 1200,
        reasoning: { effort: 'none' },
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'language_practice_coaching',
            strict: true,
            schema: coachSchema,
          },
        },
      })
      code = 'output_envelope'
      if (!response || typeof response !== 'object') throw new Error()
      const record = response as Record<string, unknown>
      if (record.status === 'incomplete') { code = 'output_incomplete'; throw new Error() }
      if (hasRefusal(record.output)) { code = 'output_refusal'; throw new Error() }
      if (typeof record.output_text !== 'string' || record.output_text.length > MAX_STRUCTURED_OUTPUT_LENGTH) {
        throw new Error()
      }
      return parseCoachResult(record.output_text, input.transcript)
    } catch (error) {
      const detail: CoachDiagnostic = { code, component: 'coach', phase: 'request' }
      if (error instanceof InvalidCoachResultError) detail.code = 'output_validation'
      else if (error instanceof APIConnectionTimeoutError) detail.code = 'provider_timeout'
      else if (error instanceof APIConnectionError) detail.code = 'provider_connection'
      else if (error instanceof APIError) {
        const status = Object.getOwnPropertyDescriptor(error, 'status')?.value
        if ([400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504].includes(status)) {
          detail.code = 'provider_http'; detail.providerStatus = status
        }
      }
      const unavailable = new CoachAdapterUnavailableError()
      coachDiagnostics.set(unavailable, detail)
      throw unavailable
    }
  }
}

function hasRefusal(output: unknown): boolean {
  if (!Array.isArray(output)) return false
  return output.some((item) => {
    if (!item || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    if (record.type !== 'message' || !Array.isArray(record.content)) return false
    return record.content.some((content) =>
      content !== null && typeof content === 'object' &&
      (content as Record<string, unknown>).type === 'refusal',
    )
  })
}
