import { paypalFetch } from "@/lib/paypal/client";
import type { Money } from "@/types/renewal";

export type PaypalSubscription = {
  id: string;
  plan_id?: string;
  status: string;
  billing_info?: {
    outstanding_balance?: Money;
    failed_payments_count?: number;
    next_billing_time?: string;
    last_payment?: unknown;
  };
};

/** Live GET — source of truth for desk rows (not Simulator). */
export async function getSubscription(
  subscriptionId: string
): Promise<PaypalSubscription> {
  return paypalFetch<PaypalSubscription>(
    `/v1/billing/subscriptions/${subscriptionId}`
  );
}

/**
 * Capture outstanding balance on the subscription.
 * Only call from merchant Approve after policy re-check.
 * Never auto-capture on list/propose/refresh.
 * Pass requestId → PayPal-Request-Id for capture idempotency.
 */
export async function captureOutstanding(
  subscriptionId: string,
  note: string,
  amount?: Money,
  opts?: { requestId?: string }
): Promise<{ status?: string; id?: string }> {
  const body: Record<string, unknown> = {
    note,
    capture_type: "OUTSTANDING_BALANCE",
  };
  if (amount) body.amount = amount;
  const headers: Record<string, string> = {};
  if (opts?.requestId) {
    headers["PayPal-Request-Id"] = opts.requestId;
  }
  return paypalFetch(`/v1/billing/subscriptions/${subscriptionId}/capture`, {
    method: "POST",
    prefer: "return=representation",
    body,
    headers,
  });
}

export type PaypalSubscriptionTransaction = {
  id?: string;
  status?: string;
  time?: string;
  amount_with_breakdown?: {
    gross_amount?: Money;
    fee_amount?: Money;
    net_amount?: Money;
  };
};

/**
 * Live GET transactions for a subscription (start/end required by PayPal).
 * Probe (I-J8R13K0F76X4): COMPLETED rows only; failures do not appear here —
 * use outstanding / failed_payments_count on the subscription GET instead.
 */
export async function listSubscriptionTransactions(
  subscriptionId: string,
  opts?: { startTime?: string; endTime?: string }
): Promise<PaypalSubscriptionTransaction[]> {
  const start =
    opts?.startTime || "2024-01-01T00:00:00.000Z";
  const end = opts?.endTime || new Date().toISOString();
  const path = `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/transactions?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`;
  const data = await paypalFetch<{
    transactions?: PaypalSubscriptionTransaction[];
  }>(path);
  return Array.isArray(data.transactions) ? data.transactions : [];
}

/**
 * Revise to a cheaper ACTIVE plan. Buyer must approve — next-cycle retention, not recovered cash.
 *
 * IDEMPOTENCY: revise has NO PayPal-Request-Id / idempotency key.
 * Re-Approve may create another revise agreement; do not treat revise as money-proof recovery.
 */
export async function reviseSubscription(
  subscriptionId: string,
  planId: string
): Promise<{ links?: Array<{ rel: string; href: string }> }> {
  return paypalFetch(`/v1/billing/subscriptions/${subscriptionId}/revise`, {
    method: "POST",
    prefer: "return=representation",
    body: { plan_id: planId },
  });
}

/**
 * Reactivate a SUSPENDED subscription after outstanding is cleared.
 * Only call from merchant Approve (same passcode gate) once money proof holds.
 */
export async function activateSubscription(
  subscriptionId: string,
  reason = "Renewal Rescue — outstanding cleared; resume billing"
): Promise<{ status?: string; id?: string; httpStatus?: number }> {
  return paypalFetch(`/v1/billing/subscriptions/${subscriptionId}/activate`, {
    method: "POST",
    prefer: "return=representation",
    body: { reason },
  });
}
