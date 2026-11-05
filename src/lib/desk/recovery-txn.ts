import type { PaypalSubscriptionTransaction } from "@/lib/paypal/billing";

/**
 * Pure txn filters for verified balance recovery.
 *
 * Rule: COMPLETED + USD gross ≥ $5 (excludes $1 setup fee).
 * Per subscription, only the **first** such txn counts — undercounts double
 * recoveries; escalate to Approve-time correlation if needed.
 */

/** Min gross USD to count as a recovery candidate (excludes setup-fee COMPLETED $1). */
export const RECOVERED_MRR_MIN_GROSS_USD = 5;

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

/**
 * First (earliest) COMPLETED USD ≥ $5 on a subscription's live txn list.
 * Undercounts later double recoveries by design.
 */
export function firstVerifiedRecoveryTxn(
  txns: PaypalSubscriptionTransaction[]
): PaypalSubscriptionTransaction | null {
  const qualifying = txns
    .filter(isRecoveredTransaction)
    .sort((a, b) => {
      const ta = a.time || "";
      const tb = b.time || "";
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return (a.id || "").localeCompare(b.id || "");
    });
  return qualifying[0] || null;
}

export function hasFirstVerifiedRecovery(
  txns: PaypalSubscriptionTransaction[]
): boolean {
  return firstVerifiedRecoveryTxn(txns) != null;
}
