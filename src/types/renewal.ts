export type DeskStatus =
  | "ACTIVE"
  | "SUSPENDED"
  | "PAYMENT_FAILED"
  | "PROPOSED"
  | "BLOCKED"
  | "CAPTURE_PEND"
  | "REVISE_PEND"
  | "RECOVERED"
  | "REVISED"
  | "RETRY_LATER"
  | "ESCALATED";

export type RecoveryAction =
  | "capture_outstanding"
  | "revise_cheaper"
  | "retry_later"
  | "escalate";

export type Money = {
  currency_code: string;
  value: string;
};

export type RenewalProposal = {
  subscriptionId: string;
  action: RecoveryAction;
  rationale: string;
  proposedPlanId?: string;
  proposedPrice?: Money;
  /** Capture amount (≤ outstanding) or retained recovery estimate */
  impact?: Money;
  /**
   * True only for demo/$0 rows with no first COMPLETED ≥ $5 recovery txn.
   * Not inferred from outstanding alone when a verified recovery exists.
   */
  fixtureLabeled?: boolean;
};

export type PolicyResult = { ok: true } | { ok: false; reason: string };

export type PolicyContext = {
  outstanding: Money | null;
  currentPlanPrice: Money;
  /** Minimum % of outstanding that a partial capture must take (e.g. 50) */
  minCapturePct: number;
  /** Max revise discount vs current plan (e.g. 30) */
  maxDiscountPct: number;
  allowWriteOff: false;
};

export type DeskSubscription = {
  key: string;
  id: string;
  planId: string;
  planKey: string;
  failurePath: string;
  note: string;
  status: string;
  outstanding: Money | null;
  outstandingValue: number;
  failedPaymentsCount: number | null;
  nextBillingTime: string | null;
  lastPayment: unknown;
  refreshedAt: string;
  preferredCaptureTarget: boolean;
  fixtureLabeled: boolean;
  /** Desk badge: Outstanding / Fixture / Balance recovered… / Subscription restored */
  cardLabel?: string;
  /** True when live txn list has a first COMPLETED USD ≥ $5 recovery. */
  hasVerifiedRecovery?: boolean;
  currentPlanPrice: Money;
};
