/**
 * Client-side verified balance-recovery board merge.
 *
 * Approve returns a Recovery-pending row; GET /api/recovered-mrr only counts
 * the first live PayPal COMPLETED ≥ $5 per sub as verified and can lag across
 * Vercel lambdas (session memory does not cross instances). Keep Approve rows
 * as an optimistic overlay until PayPal returns the same txn / proposal / id.
 * Pending overlays are excluded from the verified total.
 */

export type RecoveredBoardMoney = { currency_code: string; value: string };

export type RecoveredBoardRow = {
  id: string;
  subscriptionId: string;
  pathKey?: string;
  amountRecovered: RecoveredBoardMoney;
  transactionId: string | null;
  transactionStatus: string | null;
  recoveredAt: string;
  source: string;
  pending?: boolean;
  proposalId?: string;
  note?: string;
  /** Honest attribution from server — verified vs completed payment. */
  attribution?: "verified_recovery" | "completed_payment" | "pending" | string;
};

/** Dedupe key: transactionId → proposalId → id. */
export function recoveredRowDedupeKey(row: {
  id: string;
  transactionId?: string | null;
  proposalId?: string | null;
}): string {
  if (row.transactionId) return `txn:${row.transactionId}`;
  if (row.proposalId) return `proposal:${row.proposalId}`;
  return `id:${row.id}`;
}

function rowKeys(row: {
  id: string;
  transactionId?: string | null;
  proposalId?: string | null;
}): string[] {
  const keys = [`id:${row.id}`];
  if (row.transactionId) keys.push(`txn:${row.transactionId}`);
  if (row.proposalId) keys.push(`proposal:${row.proposalId}`);
  return keys;
}

function sortNewestFirst(rows: RecoveredBoardRow[]): RecoveredBoardRow[] {
  return [...rows].sort((a, b) =>
    a.recoveredAt < b.recoveredAt ? 1 : a.recoveredAt > b.recoveredAt ? -1 : 0
  );
}

function isServerVerifiedForSub(row: RecoveredBoardRow): boolean {
  if (row.pending) return false;
  if (row.source === "desk_approve") return false;
  if (row.source !== "paypal_transactions") return false;
  if (row.attribution === "completed_payment") return false;
  return true;
}

/**
 * Merge server board rows with optimistic Approve overlays.
 * Server wins on matching txn / proposal / id; optimistic kept when server lags
 * (including empty server responses).
 * Drop optimistic row when a verified server row exists for the same
 * subscriptionId (avoids double-row after settle Refresh).
 */
export function mergeRecoveredBoard(
  serverRows: RecoveredBoardRow[],
  optimisticRows: RecoveredBoardRow[]
): RecoveredBoardRow[] {
  const byKey = new Map<string, RecoveredBoardRow>();
  const covered = new Set<string>();
  const verifiedSubs = new Set<string>();

  for (const r of serverRows) {
    const primary = recoveredRowDedupeKey(r);
    byKey.set(primary, r);
    for (const k of rowKeys(r)) covered.add(k);
    if (isServerVerifiedForSub(r) && r.subscriptionId) {
      verifiedSubs.add(r.subscriptionId);
    }
  }

  for (const r of optimisticRows) {
    // Verified server row for same sub → drop optimistic overlay (no double-row).
    if (r.subscriptionId && verifiedSubs.has(r.subscriptionId)) continue;
    const keys = rowKeys(r);
    if (keys.some((k) => covered.has(k))) continue;
    const primary = recoveredRowDedupeKey(r);
    if (byKey.has(primary)) continue;
    byKey.set(primary, r);
    for (const k of keys) covered.add(k);
  }

  return sortNewestFirst([...byKey.values()]);
}

/** Verified total — excludes Recovery pending / desk_approve / completed_payment. */
export function isVerifiedBoardRow(row: {
  source?: string;
  pending?: boolean;
  attribution?: string;
}): boolean {
  if (row.pending) return false;
  if (row.source === "desk_approve") return false;
  if (row.source !== "paypal_transactions") return false;
  if (row.attribution === "completed_payment") return false;
  return true;
}

export function sumRecoveredBoardUsd(rows: RecoveredBoardRow[]): number {
  return rows.reduce((acc, r) => {
    if (!isVerifiedBoardRow(r)) return acc;
    if (r.amountRecovered.currency_code !== "USD") return acc;
    const n = Number(r.amountRecovered.value);
    return Number.isFinite(n) ? acc + n : acc;
  }, 0);
}

/** Board source badge: verified vs completed payment vs Recovery pending. */
export function recoveryBoardSourceLabel(row: {
  source?: string;
  pending?: boolean;
  attribution?: string;
}): string {
  if (row.pending || row.source === "desk_approve") return "Recovery pending";
  if (row.attribution === "completed_payment") {
    return "Completed subscription payment";
  }
  if (row.source === "paypal_transactions") return "Verified";
  return row.source || "unknown";
}

/** Upsert one optimistic row (dedupe by txn / proposal / id). */
export function upsertOptimisticRecovered(
  existing: RecoveredBoardRow[],
  row: RecoveredBoardRow
): RecoveredBoardRow[] {
  return mergeRecoveredBoard([], [row, ...existing]);
}

/**
 * Coerce Approve `recovered` payload into a board row.
 * Returns null when shape is unusable.
 */
export function coerceRecoveredBoardRow(
  raw: unknown
): RecoveredBoardRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const amount = r.amountRecovered;
  if (!amount || typeof amount !== "object") return null;
  const money = amount as Record<string, unknown>;
  if (
    typeof money.currency_code !== "string" ||
    typeof money.value !== "string"
  ) {
    return null;
  }
  if (typeof r.id !== "string" || typeof r.subscriptionId !== "string") {
    return null;
  }
  const amountNum = Number.parseFloat(money.value);
  const source = typeof r.source === "string" ? r.source : "desk_approve";
  const pending =
    typeof r.pending === "boolean"
      ? r.pending
      : source === "desk_approve";
  return {
    id: r.id,
    subscriptionId: r.subscriptionId,
    pathKey: typeof r.pathKey === "string" ? r.pathKey : undefined,
    amountRecovered: {
      currency_code: money.currency_code,
      value: Number.isFinite(amountNum) ? amountNum.toFixed(2) : money.value,
    },
    transactionId:
      typeof r.transactionId === "string" ? r.transactionId : null,
    // Pending overlays: keep null status — do not invent COMPLETED.
    transactionStatus:
      typeof r.transactionStatus === "string"
        ? r.transactionStatus
        : pending
          ? null
          : null,
    recoveredAt:
      typeof r.recoveredAt === "string"
        ? r.recoveredAt
        : new Date().toISOString(),
    source,
    pending,
    proposalId: typeof r.proposalId === "string" ? r.proposalId : undefined,
    note: typeof r.note === "string" ? r.note : undefined,
    attribution:
      typeof r.attribution === "string" ? r.attribution : undefined,
  };
}

/** True when server rows already include this optimistic recovery. */
export function serverHasRecovery(
  serverRows: RecoveredBoardRow[],
  needle: {
    transactionId?: string | null;
    proposalId?: string | null;
    id?: string;
  }
): boolean {
  const want = new Set<string>();
  if (needle.transactionId) want.add(`txn:${needle.transactionId}`);
  if (needle.proposalId) want.add(`proposal:${needle.proposalId}`);
  if (needle.id) want.add(`id:${needle.id}`);
  if (want.size === 0) return false;
  for (const r of serverRows) {
    for (const k of rowKeys(r)) {
      if (want.has(k)) return true;
    }
  }
  return false;
}
