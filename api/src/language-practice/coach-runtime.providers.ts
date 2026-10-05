import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import OpenAI from 'openai'
import { CoachAdapter, type CoachResponsesClient } from './coach-adapter'

export const ALLOWED_COACH_MODELS = ['gpt-5.6-luna', 'gpt-6-luna'] as const
export type AllowedCoachModel = (typeof ALLOWED_COACH_MODELS)[number]

export type OpenAIConstructor = new (options: {
  apiKey: string
  maxRetries: 0
  timeout: 90_000
}) => unknown

export type CoachRuntimeConfig = {
  keyFilePath: string
  model: string
}

export class CoachRuntimeConfigurationError extends Error {
  constructor() {
    super('The conversation coach is not configured')
    this.name = 'CoachRuntimeConfigurationError'
  }
}

/** Parse exactly one non-empty OPENAI_API_KEY assignment without exposing its value. */
export function parseCoachKeyFile(contents: string): string {
  const match = /^OPENAI_API_KEY=([\x21-\x7e]+)\n?$/.exec(contents)
  if (!match || match[0] !== contents) {
    throw new CoachRuntimeConfigurationError()
  }
  return match[1]
}

/** Constructed only by a future, explicitly authorized caller; this module is not registered. */
export type OpenAIResponsesClientFactoryOptions = {
  OpenAIConstructor?: OpenAIConstructor
  readFile?: (filePath: string) => string
  inspectFile?: (filePath: string) => { isFile(): boolean; mode: number }
}

/** Construct an inert Responses API client from an explicitly configured, private key file. */
export function createOpenAIResponsesClient<T = CoachResponsesClient>(
  config: CoachRuntimeConfig,
  options: OpenAIResponsesClientFactoryOptions = {},
): T {
  if (
    !config || typeof config.keyFilePath !== 'string' ||
    !isAbsolute(config.keyFilePath) ||
    !ALLOWED_COACH_MODELS.some((model) => model === config.model)
  ) {
    throw new CoachRuntimeConfigurationError()
  }

  try {
    const inspectFile = options.inspectFile ?? ((filePath) => lstatSync(filePath))
    const metadata = inspectFile(config.keyFilePath)
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new CoachRuntimeConfigurationError()
    }
    const readFile = options.readFile ?? ((filePath) => readFileSync(filePath, 'utf8'))
    const apiKey = parseCoachKeyFile(readFile(config.keyFilePath))
    const Sdk = options.OpenAIConstructor ?? (OpenAI as unknown as OpenAIConstructor)
    return new Sdk({ apiKey, maxRetries: 0, timeout: 90_000 }) as T
  } catch {
    throw new CoachRuntimeConfigurationError()
  }
}

/** Construct the legacy turn adapter over the shared, guarded Responses client. */
export function createOpenAICoachAdapter(
  config: CoachRuntimeConfig,
  options: OpenAIResponsesClientFactoryOptions = {},
): CoachAdapter {
  try {
    return new CoachAdapter(createOpenAIResponsesClient(config, options), config.model)
  } catch {
    throw new CoachRuntimeConfigurationError()
  }
}
