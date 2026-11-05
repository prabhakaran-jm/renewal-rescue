/**
 * Customer card badges for the recovery desk.
 *
 * fixtureLabeled must NOT be true solely because outstanding is $0 when a
 * first COMPLETED USD ≥ $5 recovery txn exists on the live list.
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
 * the first verified ≥ $5 COMPLETED recovery exists.
 */
export function deskCardBadge(opts: {
  outstandingValue: number;
  status: string;
  hasVerifiedRecovery: boolean;
}): DeskCardBadge {
  const outstanding = Number.isFinite(opts.outstandingValue)
    ? opts.outstandingValue
    : 0;

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

  if (outstanding > 0) {
    return {
      kind: "outstanding",
      label: "Outstanding",
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
