/**
 * Same-instance session rows for Recovery-pending Approve overlays.
 * Shared so seed card attribution and the recovered board read the same
 * correlated capture txn ids without a seed ↔ recovered-mrr import cycle.
 */

export type SessionRecoveredRow = {
  id: string;
  subscriptionId: string;
  transactionId: string | null;
  proposalId?: string;
  pending?: boolean;
  source?: string;
};

const g = globalThis as typeof globalThis & {
  __renewalRescueRecoveredSession?: SessionRecoveredRow[];
};

export function recoverySessionRows(): SessionRecoveredRow[] {
  if (!g.__renewalRescueRecoveredSession) {
    g.__renewalRescueRecoveredSession = [];
  }
  return g.__renewalRescueRecoveredSession;
}

export function setRecoverySessionRows(rows: SessionRecoveredRow[]): void {
  g.__renewalRescueRecoveredSession = rows;
}

/** Txn ids recorded on desk Approve/capture in this instance (correlation). */
export function correlatedCaptureTxnIds(): Set<string> {
  const ids = new Set<string>();
  for (const r of recoverySessionRows()) {
    if (r.transactionId) ids.add(r.transactionId);
  }
  return ids;
}

export function clearRecoverySessionForTests(): void {
  g.__renewalRescueRecoveredSession = [];
}
