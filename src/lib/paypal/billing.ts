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
 */
export async function captureOutstanding(
  subscriptionId: string,
  note: string,
  amount?: Money
): Promise<{ status?: string; id?: string }> {
  const body: Record<string, unknown> = {
    note,
    capture_type: "OUTSTANDING_BALANCE",
  };
  if (amount) body.amount = amount;
  return paypalFetch(`/v1/billing/subscriptions/${subscriptionId}/capture`, {
    method: "POST",
    prefer: "return=representation",
    body,
  });
}

/**
 * Revise to a cheaper ACTIVE plan. Buyer must approve — next-cycle retention, not recovered cash.
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
