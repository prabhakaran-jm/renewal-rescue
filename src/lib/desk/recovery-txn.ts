import type { PaypalSubscriptionTransaction } from "@/lib/paypal/billing";

/**
 * Pure txn filters for verified balance recovery.
 *
 * Qualifying payment: COMPLETED + USD gross ≥ $5 (excludes $1 setup fee).
 *
 * Verified balance recovery (honest attribution): a qualifying payment is
 * "verified recovery" only when its txn id is on the audited historical
 * allowlist OR correlated to a desk Approve/capture (recorded capture txn /
 * proposal session). Otherwise label it a completed subscription payment —
 * do not claim generic first-$5 COMPLETED as desk-verified recovery.
 */

/** Min gross USD to count as a recovery candidate (excludes setup-fee COMPLETED $1). */
export const RECOVERED_MRR_MIN_GROSS_USD = 5;

/**
 * Audited historical desk-capture COMPLETED txn ids for the live $16 board
 * (money-proof $5 + film $5 + smoke $6). Documented from fixtures / film docs:
 *
 * - `7RG29592AA729850V` — $5.00 money proof on `I-J8R13K0F76X4`
 *   (fixtures/money-proof/I-J8R13K0F76X4-2026-10-31.json)
 * - `57J03146YN2648933` — $5.00 film capture on `I-CNCX69GD2UD8`
 *   (project film / settle docs)
 * - Third $6.00 smoke on `I-3FSFGWWRAV4D` — txn id not present in repo
 *   fixtures/tests; counted only via desk capture correlation when recorded.
 */
export const AUDITED_VERIFIED_RECOVERY_TXN_IDS: ReadonlySet<string> = new Set([
  "7RG29592AA729850V",
  "57J03146YN2648933",
]);

export function isAuditedVerifiedRecoveryTxnId(
  txnId: string | null | undefined
): boolean {
  return typeof txnId === "string" && AUDITED_VERIFIED_RECOVERY_TXN_IDS.has(txnId);
}

/**
 * Probe-informed filter: COMPLETED USD gross >= $5.
 * Setup-fee $1 COMPLETED rows are excluded.
 * This is a payment qualifier — not proof of desk-verified recovery.
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
 * True when a qualifying COMPLETED ≥ $5 has desk-verified attribution:
 * audited historical allowlist OR correlated recorded capture txn id.
 */
export function isVerifiedBalanceRecoveryTxn(
  t: PaypalSubscriptionTransaction,
  correlatedTxnIds: ReadonlySet<string> = new Set()
): boolean {
  if (!isRecoveredTransaction(t)) return false;
  const id = t.id;
  if (!id) return false;
  return isAuditedVerifiedRecoveryTxnId(id) || correlatedTxnIds.has(id);
}

/**
 * First (earliest) COMPLETED USD ≥ $5 on a subscription's live txn list.
 * Qualifying payment only — may or may not be verified recovery.
 */
export function firstQualifyingCompletedTxn(
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

/**
 * First (earliest) desk-verified recovery txn (allowlist or correlated).
 * Undercounts later double recoveries by design.
 */
export function firstVerifiedRecoveryTxn(
  txns: PaypalSubscriptionTransaction[],
  correlatedTxnIds: ReadonlySet<string> = new Set()
): PaypalSubscriptionTransaction | null {
  const verified = txns
    .filter((t) => isVerifiedBalanceRecoveryTxn(t, correlatedTxnIds))
    .sort((a, b) => {
      const ta = a.time || "";
      const tb = b.time || "";
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return (a.id || "").localeCompare(b.id || "");
    });
  return verified[0] || null;
}

export function hasFirstVerifiedRecovery(
  txns: PaypalSubscriptionTransaction[],
  correlatedTxnIds: ReadonlySet<string> = new Set()
): boolean {
  return firstVerifiedRecoveryTxn(txns, correlatedTxnIds) != null;
}
