export type PendingTurn = { blob: Blob; clientTurnId: string }

export function canRecordTurn(pending: PendingTurn | null, submitting: boolean, sessionActive: boolean): boolean {
  return pending === null && !submitting && sessionActive
}

export function nextTurnState(status: 'PROCESSING' | 'COMPLETED' | 'FAILED'): 'pending' | 'resolved' {
  return status === 'PROCESSING' ? 'pending' : 'resolved'
}
