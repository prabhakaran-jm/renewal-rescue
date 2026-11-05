/**
 * Customer card badges for the recovery desk.
 *
 * fixtureLabeled must NOT be true solely because outstanding is $0 when a
 * verified ≥ $5 COMPLETED recovery txn exists on the live list.
 *
 * Outstanding balance is checked before verified-recovery labels so a sub
 * that still owes money never shows “Balance recovered…”.
 */

export type DeskCardBadgeKind =
  | "outstanding"
  | "fixture"
  | "balance_recovered_pending"
  | "subscription_restored";

export type DeskCardBadge = {
  kind: DeskCardBadgeKind;
  /** Short badge text for the sub row. */
  label: string;
  fixtureLabeled: boolean;
};

/**
 * Derive card badge from live outstanding, subscription status, and whether
 * a desk-verified ≥ $5 COMPLETED recovery exists (allowlist / correlation).
 */
export function deskCardBadge(opts: {
  outstandingValue: number;
  status: string;
  hasVerifiedRecovery: boolean;
}): DeskCardBadge {
  const outstanding = Number.isFinite(opts.outstandingValue)
    ? opts.outstandingValue
    : 0;

  // Outstanding wins — even if a verified recovery txn also exists.
  if (outstanding > 0) {
    return {
      kind: "outstanding",
      label: "Outstanding",
      fixtureLabeled: false,
    };
  }

  if (opts.hasVerifiedRecovery) {
    if (opts.status === "ACTIVE") {
      return {
        kind: "subscription_restored",
        label: "Subscription restored",
        fixtureLabeled: false,
      };
    }
    return {
      kind: "balance_recovered_pending",
      label: "Balance recovered, reactivation pending",
      fixtureLabeled: false,
    };
  }

  return {
    kind: "fixture",
    label: "Fixture",
    fixtureLabeled: true,
  };
}

/** Format desk money for cards — always two decimals. */
export function formatDeskAmount(
  value: number | string | null | undefined,
  currencyCode = "USD"
): string {
  const n =
    typeof value === "number"
      ? value
      : value == null || value === ""
        ? NaN
        : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return `0.00 ${currencyCode}`;
  return `${n.toFixed(2)} ${currencyCode}`;
}
