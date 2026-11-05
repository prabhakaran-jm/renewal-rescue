import type { Money } from "@/types/renewal";
import {
  listSubscriptionTransactions,
  type PaypalSubscriptionTransaction,
} from "@/lib/paypal/billing";
import {
  clearRecoverySessionForTests,
  correlatedCaptureTxnIds,
  recoverySessionRows,
  setRecoverySessionRows,
} from "@/lib/desk/recovery-session";
import {
  firstQualifyingCompletedTxn,
  firstVerifiedRecoveryTxn,
  isRecoveredTransaction,
} from "@/lib/desk/recovery-txn";
import { recoveredMrrSubscriptionIds } from "@/lib/desk/seed";

export {
  AUDITED_VERIFIED_RECOVERY_TXN_IDS,
  firstQualifyingCompletedTxn,
  firstVerifiedRecoveryTxn,
  hasFirstVerifiedRecovery,
  isAuditedVerifiedRecoveryTxnId,
  isRecoveredTransaction,
  isVerifiedBalanceRecoveryTxn,
  RECOVERED_MRR_MIN_GROSS_USD,
} from "@/lib/desk/recovery-txn";
export { correlatedCaptureTxnIds } from "@/lib/desk/recovery-session";

/**
 * Verified balance-recovery board — derived from live PayPal subscription
 * transactions (not “MRR uplift”).
 *
 * Probe (GET …/I-J8R13K0F76X4/transactions, 2026-11-02):
 * - Two COMPLETED rows: $5.00 capture (7RG29592AA729850V) + $1.00 setup fee.
 * - No FAILED rows in the transactions list (failures show on subscription
 *   outstanding / failed_payments_count, not as txn status=FAILED here).
 *
 * Attribution (recomputed each Refresh from the live txn list):
 * - Qualifying payment = first COMPLETED USD gross ≥ $5 (excludes $1 setup).
 * - Verified balance recovery only when that txn is on the audited historical
 *   allowlist (7RG29592AA729850V, 57J03146YN2648933 — $16 board ledger) OR
 *   correlated via a recorded desk Approve/capture txn id.
 * - Uncorrelated qualifying payments are labeled “Completed subscription
 *   payment” and excluded from the verified total.
 *
 * Optimistic / desk_approve rows are “Recovery pending” and must be excluded
 * from the verified total until the PayPal txn list confirms them.
 */

export type RecoveryAttribution =
  | "verified_recovery"
  | "completed_payment"
  | "pending";

export type RecoveredMrrRow = {
  id: string;
  subscriptionId: string;
  pathKey?: string;
  recoveryAction: "capture_outstanding";
  amountRecovered: Money;
  deskStatus: "RECOVERED";
  transactionId: string | null;
  transactionStatus: string | null;
  recoveredAt: string;
  outstandingCleared: true;
  source: "paypal_transactions" | "desk_approve";
  /** True for optimistic Approve overlays — not verified yet. */
  pending?: boolean;
  proposalId?: string;
  note?: string;
  /** Honest board attribution — verified vs completed payment vs pending. */
  attribution?: RecoveryAttribution;
};

function sessionRows(): RecoveredMrrRow[] {
  return recoverySessionRows() as RecoveredMrrRow[];
}

function txnToRow(
  subscriptionId: string,
  t: PaypalSubscriptionTransaction,
  attribution: "verified_recovery" | "completed_payment"
): RecoveredMrrRow | null {
  if (!isRecoveredTransaction(t)) return null;
  const gross = t.amount_with_breakdown!.gross_amount!;
  const txnId = t.id || null;
  const verified = attribution === "verified_recovery";
  return {
    id: txnId ? `paypal_${txnId}` : `paypal_${subscriptionId}_${t.time}`,
    subscriptionId,
    recoveryAction: "capture_outstanding",
    amountRecovered: {
      currency_code: gross.currency_code,
      value: Number.parseFloat(gross.value).toFixed(2),
    },
    deskStatus: "RECOVERED",
    transactionId: txnId,
    transactionStatus: t.status || "COMPLETED",
    recoveredAt: t.time || new Date().toISOString(),
    outstandingCleared: true,
    source: "paypal_transactions",
    pending: false,
    attribution,
    note: verified
      ? "Verified balance recovery — audited historical capture or desk Approve/capture correlation."
      : "Completed subscription payment — qualifying COMPLETED ≥ $5 without desk capture correlation.",
  };
}

export async function listRecoveredMrrFromPaypal(
  subscriptionIds: string[] = recoveredMrrSubscriptionIds(),
  correlatedTxnIds: ReadonlySet<string> = correlatedCaptureTxnIds()
): Promise<RecoveredMrrRow[]> {
  const bySub = new Map<string, RecoveredMrrRow>();
  for (const subscriptionId of subscriptionIds) {
    let txns: PaypalSubscriptionTransaction[] = [];
    try {
      txns = await listSubscriptionTransactions(subscriptionId);
    } catch {
      // Skip ids that 404 / error — board still returns other recoveries
      continue;
    }
    // Prefer verified (allowlist / correlated); else honest completed payment.
    const verified = firstVerifiedRecoveryTxn(txns, correlatedTxnIds);
    if (verified) {
      const row = txnToRow(subscriptionId, verified, "verified_recovery");
      if (row) bySub.set(subscriptionId, row);
      continue;
    }
    const qualifying = firstQualifyingCompletedTxn(txns);
    if (!qualifying) continue;
    const row = txnToRow(subscriptionId, qualifying, "completed_payment");
    if (row) bySub.set(subscriptionId, row);
  }
  return [...bySub.values()].sort((a, b) =>
    a.recoveredAt < b.recoveredAt ? 1 : a.recoveredAt > b.recoveredAt ? -1 : 0
  );
}

/** Live PayPal rows + same-instance Approve pendings (deduped). */
export async function listRecoveredMrr(): Promise<RecoveredMrrRow[]> {
  const correlated = correlatedCaptureTxnIds();
  const fromPaypal = await listRecoveredMrrFromPaypal(
    recoveredMrrSubscriptionIds(),
    correlated
  );
  const byKey = new Map<string, RecoveredMrrRow>();
  for (const r of fromPaypal) {
    byKey.set(r.transactionId || r.id, r);
  }
  for (const r of sessionRows()) {
    const key = r.transactionId || r.proposalId || r.id;
    if (!byKey.has(key)) byKey.set(key, { ...r, pending: true, attribution: "pending" });
  }
  return [...byKey.values()].sort((a, b) =>
    a.recoveredAt < b.recoveredAt ? 1 : a.recoveredAt > b.recoveredAt ? -1 : 0
  );
}

/** Verified total only — excludes pending, desk_approve, and completed_payment. */
export function isVerifiedRecoveryRow(row: {
  source?: string;
  pending?: boolean;
  attribution?: RecoveryAttribution | string;
}): boolean {
  if (row.pending) return false;
  if (row.source !== "paypal_transactions") return false;
  if (row.attribution === "completed_payment") return false;
  if (row.attribution === "pending") return false;
  // attribution verified_recovery or legacy rows without attribution field
  // that already passed source/pending checks — prefer explicit when present.
  if (row.attribution != null && row.attribution !== "verified_recovery") {
    return false;
  }
  return true;
}

export function sumRecoveredUsd(rows: RecoveredMrrRow[]): number {
  return rows.reduce((acc, r) => {
    if (!isVerifiedRecoveryRow(r)) return acc;
    if (r.amountRecovered.currency_code !== "USD") return acc;
    const n = Number(r.amountRecovered.value);
    return Number.isFinite(n) ? acc + n : acc;
  }, 0);
}

function extractTxnId(paypal: unknown): string | null {
  if (!paypal || typeof paypal !== "object") return null;
  const p = paypal as Record<string, unknown>;
  if (typeof p.id === "string") return p.id;
  const links = p.links;
  if (Array.isArray(links)) {
    for (const link of links) {
      if (link && typeof link === "object" && "href" in link) {
        const href = String((link as { href: string }).href);
        const m = href.match(/\/transactions\/([A-Z0-9]+)/i);
        if (m) return m[1];
      }
    }
  }
  return null;
}

export type AppendRecoveredInput = {
  subscriptionId: string;
  pathKey?: string;
  amount: Money;
  paypal?: unknown;
  proposalId?: string;
  note?: string;
};

/**
 * Session append after cleared capture — Recovery pending until the live
 * txn list confirms via allowlist or recorded capture txn correlation.
 * Prefer live list on Refresh. Pending rows use transactionStatus: null
 * until PayPal confirms (do not default COMPLETED).
 */
export function appendVerifiedRecovery(
  input: AppendRecoveredInput
): RecoveredMrrRow {
  const rows = sessionRows();
  const txnId = extractTxnId(input.paypal);
  let txnStatus: string | null = null;
  if (
    input.paypal &&
    typeof input.paypal === "object" &&
    "status" in input.paypal
  ) {
    const raw = (input.paypal as { status?: unknown }).status;
    if (typeof raw === "string" && raw.trim()) txnStatus = raw.trim();
  }

  if (input.proposalId) {
    const existing = rows.find((r) => r.proposalId === input.proposalId);
    if (existing) return existing;
  }
  if (txnId) {
    const existing = rows.find((r) => r.transactionId === txnId);
    if (existing) return existing;
  }

  const amountValue = Number.parseFloat(input.amount.value);
  const row: RecoveredMrrRow = {
    id: `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    subscriptionId: input.subscriptionId,
    pathKey: input.pathKey,
    recoveryAction: "capture_outstanding",
    amountRecovered: {
      currency_code: input.amount.currency_code,
      value: Number.isFinite(amountValue)
        ? amountValue.toFixed(2)
        : input.amount.value,
    },
    deskStatus: "RECOVERED",
    transactionId: txnId,
    // Pending: never invent COMPLETED — null until live txn confirms.
    transactionStatus: txnStatus,
    recoveredAt: new Date().toISOString(),
    outstandingCleared: true,
    source: "desk_approve",
    pending: true,
    attribution: "pending",
    proposalId: input.proposalId,
    note:
      input.note ||
      "Recovery pending — Approve cleared outstanding; awaiting PayPal txn list confirmation.",
  };

  rows.unshift(row);
  setRecoverySessionRows(rows);
  return row;
}

/** Test helper — clear same-instance session rows. */
export function clearRecoveredSessionForTests(): void {
  clearRecoverySessionForTests();
}
