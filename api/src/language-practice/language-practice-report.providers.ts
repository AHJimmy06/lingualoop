import {
  createOpenAIResponsesClient,
  type OpenAIResponsesClientFactoryOptions,
} from './coach-runtime.providers'
import { loadLanguagePracticeTurnCoachConfig } from './language-practice-turn.providers'
import { LanguagePracticeReportAiAdapter } from './language-practice-report-ai'

/** Construct an optional report adapter only from the already validated turn-coach settings. */
export function createLanguagePracticeReportAiAdapter(
  env: NodeJS.ProcessEnv = process.env,
  options: OpenAIResponsesClientFactoryOptions = {},
): LanguagePracticeReportAiAdapter | undefined {
  const config = loadLanguagePracticeTurnCoachConfig(env)
  if (!config) return undefined
  try {
    return new LanguagePracticeReportAiAdapter(
      createOpenAIResponsesClient<ConstructorParameters<typeof LanguagePracticeReportAiAdapter>[0]>(config, options),
      config.model,
    )
  } catch {
    return undefined
  }
}
