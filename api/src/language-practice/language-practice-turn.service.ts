import type { CoachPromptInput } from './coach-prompt';
import type { CoachResult } from './coach-result';
import type { LanguagePracticeLevel, LanguagePracticeTopic } from './language-practice-session-store';

export const LANGUAGE_PRACTICE_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
export const LANGUAGE_PRACTICE_ACCEPTED_MIME_TYPES = [
  'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus',
  'audio/wav', 'audio/x-wav', 'audio/mp4',
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CONTENT = 2_000;
const TOPIC_LABELS: Record<LanguagePracticeTopic, string> = {
  travel: 'Travel', work: 'Work', studies: 'Studies', 'everyday-conversation': 'Everyday conversation',
};

export type PracticeTurn = {
  id: string;
  clientTurnId: string;
  sequence: number;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  leaseToken: string | null;
  transcript: string | null;
  assistantResponse: string | null;
  spanishCorrectionEvidence: string | null;
  completedAt: string | null;
};

export interface PracticeTurnStore {
  reserveTurn(ownerId: string, sessionId: string, clientTurnId: string): Promise<{ turn: PracticeTurn; replay: boolean }>;
  completeTurn(
    ownerId: string, sessionId: string, turnId: string, leaseToken: string,
    transcript: string, assistantResponse: string, spanishCorrectionEvidence: string,
  ): Promise<boolean>;
  failTurn(ownerId: string, sessionId: string, turnId: string, leaseToken: string): Promise<unknown>;
}

export interface OwnedPracticeContext {
  level: LanguagePracticeLevel;
  topic: LanguagePracticeTopic;
}

export interface PracticeTurnAudio {
  /** Input buffers are caller-owned and this service never mutates or clears them. */
  buffer: Buffer;
  mimeType: string;
}

export interface PracticeTurnDependencies {
  turnStore: PracticeTurnStore;
  sessions: { getOwnedSession(ownerId: string, sessionId: string): Promise<OwnedPracticeContext | null> };
  /** Required owner-filtered store boundary; no empty-history default is allowed. */
  history: { getCompletedHistory(ownerId: string, sessionId: string): Promise<CoachPromptInput['history']> };
  speechToText: { transcribeBounded(buffer: Buffer, mimeType: string): Promise<string> };
  synthesis: { synthesizeLocal(text: string, language: 'en'): Promise<Buffer> };
  coach: { respond(input: CoachPromptInput): Promise<CoachResult> };
}

export type PracticeTurnResult = { turn: PracticeTurn; audioWav: Buffer | null };

export class PracticeTurnUnavailableError extends Error {
  constructor() {
    super('Language practice turn is temporarily unavailable.');
    this.name = 'PracticeTurnUnavailableError';
  }
}

/** Inert orchestration unit. All inference and persistence are explicit injected ports. */
export class LanguagePracticeTurnService {
  constructor(private readonly dependencies: PracticeTurnDependencies) {
    if (!dependencies?.turnStore || !dependencies.sessions || !dependencies.history ||
        !dependencies.speechToText || !dependencies.synthesis || !dependencies.coach) {
      throw new TypeError('All language-practice turn ports are required.');
    }
  }

  async processTurn(
    ownerId: string,
    sessionId: string,
    clientTurnId: string,
    audio: PracticeTurnAudio,
  ): Promise<PracticeTurnResult> {
    validateUuid(ownerId);
    validateUuid(sessionId);
    validateUuid(clientTurnId);
    validateAudio(audio);

    let admitted: PracticeTurn | undefined;
    let completionCommitted = false;
    try {
      // Reservation is the owner check and idempotency gate; no inference/history port runs before it.
      const reservation = await this.dependencies.turnStore.reserveTurn(ownerId, sessionId, clientTurnId);
      if (reservation.replay) return { turn: reservation.turn, audioWav: null };
      admitted = reservation.turn;
      if (!admitted.leaseToken) throw new Error();

      const [context, history] = await Promise.all([
        this.dependencies.sessions.getOwnedSession(ownerId, sessionId),
        this.dependencies.history.getCompletedHistory(ownerId, sessionId),
      ]);
      if (!context || !Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES ||
          history.some((item) => !item || (item.role !== 'user' && item.role !== 'assistant') ||
            typeof item.content !== 'string' || item.content.length > MAX_HISTORY_CONTENT)) throw new Error();

      const transcript = await this.dependencies.speechToText.transcribeBounded(audio.buffer, audio.mimeType);
      const coaching = await this.dependencies.coach.respond({
        context: {
          targetLanguage: { code: 'en', label: 'English' },
          topic: { code: context.topic, label: TOPIC_LABELS[context.topic] },
          source: 'practice-catalog',
        },
        level: context.level,
        transcript,
        history,
      });
      const wav = await this.dependencies.synthesis.synthesizeLocal(coaching.assistantResponse, 'en');
      if (!Buffer.isBuffer(wav) || wav.length === 0 || wav.length > 8 * 1024 * 1024) throw new Error();
      const evidence = JSON.stringify({ correctedPhrase: coaching.correctedPhrase, feedback: coaching.feedback });
      const completion = await this.dependencies.turnStore.completeTurn(
        ownerId, sessionId, admitted.id, admitted.leaseToken, transcript, coaching.assistantResponse, evidence,
      );
      if (!completion) throw new Error();
      completionCommitted = true;
      // completeTurn returns only a boolean; a replayed owner-scoped read is the authoritative persisted result.
      const persisted = await this.dependencies.turnStore.reserveTurn(ownerId, sessionId, clientTurnId);
      const completedTurn = persisted.turn;
      if (!persisted.replay || completedTurn.status !== 'COMPLETED' || completedTurn.id !== admitted.id ||
          completedTurn.transcript !== transcript || completedTurn.assistantResponse !== coaching.assistantResponse ||
          typeof completedTurn.completedAt !== 'string' || completedTurn.completedAt.length === 0) throw new Error();
      return { turn: completedTurn, audioWav: wav };
    } catch {
      // Once completion committed, a failed authoritative reread must not attempt to fail/charge the turn again.
      if (admitted?.leaseToken && !completionCommitted) {
        try {
          await this.dependencies.turnStore.failTurn(ownerId, sessionId, admitted.id, admitted.leaseToken);
        } catch {
          // Preserve a generic error and never reveal provider or persistence details.
        }
      }
      throw new PracticeTurnUnavailableError();
    }
  }
}

function validateUuid(value: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError('Invalid practice turn identifier.');
}

function validateAudio(audio: PracticeTurnAudio): void {
  if (!audio || !Buffer.isBuffer(audio.buffer) || audio.buffer.length === 0 ||
      audio.buffer.length > LANGUAGE_PRACTICE_MAX_FILE_SIZE_BYTES ||
      !(LANGUAGE_PRACTICE_ACCEPTED_MIME_TYPES as readonly string[]).includes(audio.mimeType)) {
    throw new TypeError('Invalid practice audio.');
  }
}
