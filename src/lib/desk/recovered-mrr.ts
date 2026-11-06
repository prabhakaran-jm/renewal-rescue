import type { Money } from "@/types/renewal";
import {
  listSubscriptionTransactions,
  type PaypalSubscriptionTransaction,
} from "@/lib/paypal/billing";
import {
  firstVerifiedRecoveryTxn,
  isRecoveredTransaction,
} from "@/lib/desk/recovery-txn";
import { recoveredMrrSubscriptionIds } from "@/lib/desk/seed";

export {
  firstVerifiedRecoveryTxn,
  hasFirstVerifiedRecovery,
  isRecoveredTransaction,
  RECOVERED_MRR_MIN_GROSS_USD,
} from "@/lib/desk/recovery-txn";

/**
 * Verified balance-recovery board — derived from live PayPal subscription
 * transactions (not “MRR uplift”).
 *
 * Probe (GET …/I-J8R13K0F76X4/transactions, 2026-11-02):
 * - Two COMPLETED rows: $5.00 capture (7RG29592AA729850V) + $1.00 setup fee.
 * - No FAILED rows in the transactions list (failures show on subscription
 *   outstanding / failed_payments_count, not as txn status=FAILED here).
 *
 * Attribution rule (recomputed each Refresh from the live txn list):
 * per subscription, only the **first** COMPLETED USD gross ≥ $5 counts as
 * verified balance recovery (excludes $1 setup fee). Seed ids are gated to
 * have no prior COMPLETED ≥ $5, so that first payment is the desk capture —
 * including after async NO_CONTENT Approve and on a fresh Vercel instance
 * with empty session memory.
 *
 * Live $16 ledger: 7RG29592AA729850V ($5) + 57J03146YN2648933 ($5) +
 * 8W0050137N871594H ($6 smoke).
 *
 * Undercounts double recoveries on the same subscription.
 *
 * Optimistic / desk_approve rows are “Recovery pending” and must be excluded
 * from the verified total until the PayPal txn list confirms them.
 */

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
};

const g = globalThis as typeof globalThis & {
  __renewalRescueRecoveredSession?: RecoveredMrrRow[];
};

function sessionRows(): RecoveredMrrRow[] {
  if (!g.__renewalRescueRecoveredSession) {
    g.__renewalRescueRecoveredSession = [];
  }
  return g.__renewalRescueRecoveredSession;
}

function txnToRow(
  subscriptionId: string,
  t: PaypalSubscriptionTransaction
): RecoveredMrrRow | null {
  if (!isRecoveredTransaction(t)) return null;
  const gross = t.amount_with_breakdown!.gross_amount!;
  const txnId = t.id || null;
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
    note: "First COMPLETED USD ≥ $5 from live GET …/transactions (verified balance recovery).",
  };
}

export async function listRecoveredMrrFromPaypal(
  subscriptionIds: string[] = recoveredMrrSubscriptionIds()
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
    // First ≥ $5 COMPLETED only — undercounts double recoveries on purpose.
    const first = firstVerifiedRecoveryTxn(txns);
    if (!first) continue;
    const row = txnToRow(subscriptionId, first);
    if (!row) continue;
    bySub.set(subscriptionId, row);
  }
  return [...bySub.values()].sort((a, b) =>
    a.recoveredAt < b.recoveredAt ? 1 : a.recoveredAt > b.recoveredAt ? -1 : 0
  );
}

/** Live PayPal first-$5 rows + same-instance Approve pendings (deduped). */
export async function listRecoveredMrr(): Promise<RecoveredMrrRow[]> {
  const fromPaypal = await listRecoveredMrrFromPaypal();
  const byKey = new Map<string, RecoveredMrrRow>();
  for (const r of fromPaypal) {
    byKey.set(r.transactionId || r.id, r);
  }
  for (const r of sessionRows()) {
    const key = r.transactionId || r.proposalId || r.id;
    if (!byKey.has(key)) byKey.set(key, { ...r, pending: true });
  }
  return [...byKey.values()].sort((a, b) =>
    a.recoveredAt < b.recoveredAt ? 1 : a.recoveredAt > b.recoveredAt ? -1 : 0
  );
}

/** Verified total only — excludes Recovery pending / desk_approve overlays. */
export function isVerifiedRecoveryRow(row: {
  source?: string;
  pending?: boolean;
}): boolean {
  if (row.pending) return false;
  return row.source === "paypal_transactions";
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
  // Async capture often returns NO_CONTENT with no id — that is OK; the live
  // txn list on Refresh still attributes via first COMPLETED ≥ $5.
  if (p.status === "NO_CONTENT") return null;
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
 * txn list confirms the first COMPLETED ≥ $5. Prefer live list on Refresh.
 * Pending rows use transactionStatus: null until PayPal confirms (do not
 * default COMPLETED). Empty session on another lambda is fine — verification
 * comes from the PayPal txn list, not this memory.
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
    proposalId: input.proposalId,
    note:
      input.note ||
      "Recovery pending — Approve cleared outstanding; awaiting PayPal txn list confirmation.",
  };

  rows.unshift(row);
  g.__renewalRescueRecoveredSession = rows;
  return row;
}

/** Test helper — clear same-instance session rows (simulates cold start). */
export function clearRecoveredSessionForTests(): void {
  g.__renewalRescueRecoveredSession = [];
}
