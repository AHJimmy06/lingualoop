export type TimerAnchor = { remainingMs: number; monotonicAt: number }

export function anchorTimer(serverRemainingMs: number, monotonicAt: number): TimerAnchor {
  return {
    remainingMs: Number.isFinite(serverRemainingMs) ? Math.max(0, serverRemainingMs) : 0,
    monotonicAt: Number.isFinite(monotonicAt) ? monotonicAt : 0,
  }
}

export function projectRemainingMs(anchor: TimerAnchor, monotonicNow: number): number {
  const elapsed = Number.isFinite(monotonicNow) ? Math.max(0, monotonicNow - anchor.monotonicAt) : 0
  return Math.max(0, anchor.remainingMs - elapsed)
}
