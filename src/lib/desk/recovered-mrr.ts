import type { Money } from "@/types/renewal";
import {
  listSubscriptionTransactions,
  type PaypalSubscriptionTransaction,
} from "@/lib/paypal/billing";
import { recoveredMrrSubscriptionIds } from "@/lib/desk/seed";

/**
 * Recovered-MRR board — derived from live PayPal subscription transactions.
 *
 * Probe (GET …/I-J8R13K0F76X4/transactions, 2026-11-02):
 * - Two COMPLETED rows: $5.00 capture (7RG29592AA729850V) + $1.00 setup fee.
 * - No FAILED rows in the transactions list (failures show on subscription
 *   outstanding / failed_payments_count, not as txn status=FAILED here).
 *
 * Rule: COMPLETED + USD gross >= 5.00 → recovery (excludes $1 setup fee).
 * Target: I-J8R13K0F76X4 contributes exactly one $5 recovery.
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
  proposalId?: string;
  note?: string;
};

/** Min gross USD to count as recovered MRR (excludes setup-fee COMPLETED $1). */
export const RECOVERED_MRR_MIN_GROSS_USD = 5;

const g = globalThis as typeof globalThis & {
  __renewalRescueRecoveredSession?: RecoveredMrrRow[];
};

/**
 * Probe-informed filter: COMPLETED USD gross >= $5.
 * Setup-fee $1 COMPLETED rows are excluded.
 */
export function isRecoveredTransaction(
  t: PaypalSubscriptionTransaction
): boolean {
  if (t.status !== "COMPLETED") return false;
  const gross = t.amount_with_breakdown?.gross_amount;
  if (!gross || gross.currency_code !== "USD") return false;
  const n = Number.parseFloat(gross.value);
  return Number.isFinite(n) && n + 1e-9 >= RECOVERED_MRR_MIN_GROSS_USD;
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
    note: "From live GET /v1/billing/subscriptions/{id}/transactions (COMPLETED gross ≥ $5).",
  };
}

export async function listRecoveredMrrFromPaypal(
  subscriptionIds: string[] = recoveredMrrSubscriptionIds()
): Promise<RecoveredMrrRow[]> {
  const byTxn = new Map<string, RecoveredMrrRow>();
  for (const subscriptionId of subscriptionIds) {
    let txns: PaypalSubscriptionTransaction[] = [];
    try {
      txns = await listSubscriptionTransactions(subscriptionId);
    } catch {
      // Skip ids that 404 / error — board still returns other recoveries
      continue;
    }
    for (const t of txns) {
      const row = txnToRow(subscriptionId, t);
      if (!row) continue;
      const key = row.transactionId || row.id;
      byTxn.set(key, row);
    }
  }
  return [...byTxn.values()].sort((a, b) =>
    a.recoveredAt < b.recoveredAt ? 1 : a.recoveredAt > b.recoveredAt ? -1 : 0
  );
}

function sessionRows(): RecoveredMrrRow[] {
  if (!g.__renewalRescueRecoveredSession) {
    g.__renewalRescueRecoveredSession = [];
  }
  return g.__renewalRescueRecoveredSession;
}

/** Live PayPal txns + same-instance Approve appends (deduped by txn id). */
export async function listRecoveredMrr(): Promise<RecoveredMrrRow[]> {
  const fromPaypal = await listRecoveredMrrFromPaypal();
  const byKey = new Map<string, RecoveredMrrRow>();
  for (const r of fromPaypal) {
    byKey.set(r.transactionId || r.id, r);
  }
  for (const r of sessionRows()) {
    const key = r.transactionId || r.proposalId || r.id;
    if (!byKey.has(key)) byKey.set(key, r);
  }
  return [...byKey.values()].sort((a, b) =>
    a.recoveredAt < b.recoveredAt ? 1 : a.recoveredAt > b.recoveredAt ? -1 : 0
  );
}

export function sumRecoveredUsd(rows: RecoveredMrrRow[]): number {
  return rows.reduce((acc, r) => {
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
 * Session append after verified capture (outstanding cleared).
 * Prefer live txn list as source of truth on next refresh.
 */
export function appendVerifiedRecovery(
  input: AppendRecoveredInput
): RecoveredMrrRow {
  const rows = sessionRows();
  const txnId = extractTxnId(input.paypal);
  const txnStatus =
    input.paypal &&
    typeof input.paypal === "object" &&
    "status" in input.paypal
      ? String((input.paypal as { status?: string }).status ?? "")
      : null;

  if (input.proposalId) {
    const existing = rows.find((r) => r.proposalId === input.proposalId);
    if (existing) return existing;
  }
  if (txnId) {
    const existing = rows.find((r) => r.transactionId === txnId);
    if (existing) return existing;
  }

  const row: RecoveredMrrRow = {
    id: `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    subscriptionId: input.subscriptionId,
    pathKey: input.pathKey,
    recoveryAction: "capture_outstanding",
    amountRecovered: input.amount,
    deskStatus: "RECOVERED",
    transactionId: txnId,
    transactionStatus: txnStatus || "COMPLETED",
    recoveredAt: new Date().toISOString(),
    outstandingCleared: true,
    source: "desk_approve",
    proposalId: input.proposalId,
    note:
      input.note ||
      "Appended after Approve RECOVERED with outstanding cleared (verified).",
  };

  rows.unshift(row);
  g.__renewalRescueRecoveredSession = rows;
  return row;
}
