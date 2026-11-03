/**
 * Client-side recovered-MRR board merge.
 *
 * Approve returns a verified row, but GET /api/recovered-mrr only sees live
 * PayPal COMPLETED ≥ $5 and can lag across Vercel lambdas (session memory
 * does not cross instances). Keep Approve rows as an optimistic overlay until
 * PayPal returns the same txn / proposal / id.
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
  proposalId?: string;
  note?: string;
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

/**
 * Merge server board rows with optimistic Approve overlays.
 * Server wins on matching txn / proposal / id; optimistic kept when server lags
 * (including empty server responses).
 */
export function mergeRecoveredBoard(
  serverRows: RecoveredBoardRow[],
  optimisticRows: RecoveredBoardRow[]
): RecoveredBoardRow[] {
  const byKey = new Map<string, RecoveredBoardRow>();
  const covered = new Set<string>();

  for (const r of serverRows) {
    const primary = recoveredRowDedupeKey(r);
    byKey.set(primary, r);
    for (const k of rowKeys(r)) covered.add(k);
  }

  for (const r of optimisticRows) {
    const keys = rowKeys(r);
    if (keys.some((k) => covered.has(k))) continue;
    const primary = recoveredRowDedupeKey(r);
    if (byKey.has(primary)) continue;
    byKey.set(primary, r);
    for (const k of keys) covered.add(k);
  }

  return sortNewestFirst([...byKey.values()]);
}

export function sumRecoveredBoardUsd(rows: RecoveredBoardRow[]): number {
  return rows.reduce((acc, r) => {
    if (r.amountRecovered.currency_code !== "USD") return acc;
    const n = Number(r.amountRecovered.value);
    return Number.isFinite(n) ? acc + n : acc;
  }, 0);
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
  return {
    id: r.id,
    subscriptionId: r.subscriptionId,
    pathKey: typeof r.pathKey === "string" ? r.pathKey : undefined,
    amountRecovered: {
      currency_code: money.currency_code,
      value: money.value,
    },
    transactionId:
      typeof r.transactionId === "string" ? r.transactionId : null,
    transactionStatus:
      typeof r.transactionStatus === "string" ? r.transactionStatus : null,
    recoveredAt:
      typeof r.recoveredAt === "string"
        ? r.recoveredAt
        : new Date().toISOString(),
    source: typeof r.source === "string" ? r.source : "desk_approve",
    proposalId: typeof r.proposalId === "string" ? r.proposalId : undefined,
    note: typeof r.note === "string" ? r.note : undefined,
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
