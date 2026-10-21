import type { Provider } from '@nestjs/common';
import { isAbsolute } from 'node:path';
import type { CoachPromptInput } from './coach-prompt';
import { CoachRuntimeConfigurationError, createOpenAICoachAdapter, type CoachRuntimeConfig } from './coach-runtime.providers';
import type { CoachAdapter } from './coach-adapter';
import { LanguagePracticeTurnService, type PracticeTurnDependencies } from './language-practice-turn.service';
import { LANGUAGE_PRACTICE_SESSION_STORE, LANGUAGE_PRACTICE_TURN_STORE } from './language-practice-session.providers';
import type { LanguagePracticeSessionStore } from './language-practice-session-store';
import type { LanguagePracticeTurnStore } from './language-practice-turn-store';
import { PracticeAudioService } from './practice-audio.service';
import { PIPER_RUNTIME, type PiperRuntimeHost } from './piper-runtime.providers';

export const LANGUAGE_PRACTICE_TURN_SERVICE = Symbol('LANGUAGE_PRACTICE_TURN_SERVICE');
export const LANGUAGE_PRACTICE_TURN_COACH = Symbol('LANGUAGE_PRACTICE_TURN_COACH');

export type LanguagePracticeTurnAssemblyPorts = Pick<PracticeTurnDependencies, 'turnStore' | 'sessions' | 'history' | 'speechToText' | 'synthesis' | 'coach'>;
export type CoachAdapterFactoryOptions = Parameters<typeof createOpenAICoachAdapter>[1];

/** Compose the orchestration service from explicit ports; no owner or history defaults are synthesized. */
export function assembleLanguagePracticeTurnService(ports: LanguagePracticeTurnAssemblyPorts): LanguagePracticeTurnService {
  return new LanguagePracticeTurnService(ports);
}

/** Read only the two explicit settings. Invalid or incomplete configuration exposes no providers. */
export function loadLanguagePracticeTurnCoachConfig(
  env: NodeJS.ProcessEnv,
): CoachRuntimeConfig | undefined {
  try {
    if (env.LINGUALOOP_OPENAI_COACH_ENABLED !== 'true') return undefined;
    const keyFilePath = env.LINGUALOOP_OPENAI_API_KEY_FILE;
    const apiKey = env.OPENAI_API_KEY;
    const model = env.LANGUAGE_PRACTICE_OPENAI_MODEL;
    if (typeof model !== 'string' ||
        (model !== 'gpt-5.6-luna' && model !== 'gpt-6-luna')) return undefined;
    if (apiKey !== undefined) {
      if (!/^[\x21-\x7e]+$/.test(apiKey)) return undefined;
      return { apiKey, model };
    }
    if (typeof keyFilePath !== 'string' || keyFilePath.length === 0 || !isAbsolute(keyFilePath) || keyFilePath.includes('\0')) return undefined;
    return { keyFilePath, model };
  } catch {
    return undefined;
  }
}

/**
 * Build opt-in Nest providers only for valid explicit coach settings. This module is intentionally
 * not included in app.module; constructing it does not issue a provider request.
 */
export function createLanguagePracticeTurnProviders(
  env: NodeJS.ProcessEnv = process.env,
  coachOptions?: CoachAdapterFactoryOptions,
): Provider[] {
  const config = loadLanguagePracticeTurnCoachConfig(env);
  if (!config) return [];
  // Reading the API key and constructing the SDK client is deferred until a user submits a turn.
  let coach: CoachAdapter | undefined;
  const lazyCoach = {
    async respond(input: CoachPromptInput) {
      coach ??= createOpenAICoachAdapter(config, coachOptions);
      return coach.respond(input);
    },
  };
  return [
    {
      provide: LANGUAGE_PRACTICE_TURN_COACH,
      useValue: lazyCoach,
    },
    {
      provide: LANGUAGE_PRACTICE_TURN_SERVICE,
      inject: [
        LANGUAGE_PRACTICE_TURN_STORE,
        LANGUAGE_PRACTICE_SESSION_STORE,
        PracticeAudioService,
        PIPER_RUNTIME,
        LANGUAGE_PRACTICE_TURN_COACH,
      ],
      useFactory: (
        turnStore: LanguagePracticeTurnStore,
        sessionStore: LanguagePracticeSessionStore,
        audio: PracticeAudioService,
        piper: Pick<PiperRuntimeHost, 'getHost'>,
        coach: Pick<CoachAdapter, 'respond'>,
      ) => assembleLanguagePracticeTurnService({
        turnStore,
        sessions: {
          async getOwnedSession(ownerId, sessionId) {
            return sessionStore.getOwnedSnapshot(ownerId, sessionId);
          },
        },
        history: {
          getCompletedHistory(ownerId, sessionId): Promise<CoachPromptInput['history']> {
            return turnStore.getCompletedHistory(ownerId, sessionId);
          },
        },
        speechToText: {
          transcribeBounded(buffer, mimeType) {
            return audio.transcribe(buffer, mimeType);
          },
        },
        synthesis: {
          synthesizeLocal(text, language) {
            return piper.getHost(language).synthesize(text);
          },
        },
        coach,
      }),
    },
  ];
}

export { CoachRuntimeConfigurationError };
