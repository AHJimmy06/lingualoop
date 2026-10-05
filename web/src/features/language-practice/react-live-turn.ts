import type { PendingTurn } from './live-turn-state';

type TurnStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';
type TurnResponse = { status: TurnStatus; [key: string]: unknown };
type TurnResult =
  | { kind: 'processing'; response: TurnResponse }
  | { kind: 'completed'; response: TurnResponse }
  | { kind: 'failed'; response: TurnResponse }
  | { kind: 'uncertain'; cause: unknown }
  | { kind: 'idle' };

export class LiveTurnController {
  pending: PendingTurn | null = null;
  submitting = false;

  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

  record(blob: Blob, sessionActive: boolean): PendingTurn | null {
    if (!this.canRecord(sessionActive)) return null;
    this.pending = { blob, clientTurnId: this.createId() };
    return this.pending;
  }

  canRecord(sessionActive: boolean): boolean {
    return this.pending === null && !this.submitting && sessionActive;
  }

  async check(
    sessionId: string,
    submit: (sessionId: string, blob: Blob, clientTurnId: string) => Promise<TurnResponse>,
  ): Promise<TurnResult> {
    const turn = this.pending;
    if (!turn || this.submitting || !sessionId) return { kind: 'idle' };
    this.submitting = true;
    try {
      const response = await submit(sessionId, turn.blob, turn.clientTurnId);
      if (this.pending !== turn) return { kind: 'idle' };
      if (response.status === 'PROCESSING') return { kind: 'processing', response };
      this.pending = null;
      return response.status === 'COMPLETED'
        ? { kind: 'completed', response }
        : { kind: 'failed', response };
    } catch (cause) {
      return { kind: 'uncertain', cause };
    } finally {
      this.submitting = false;
    }
  }
}
