import { reviseSubscription } from "@/lib/paypal/billing";

/**
 * Retention revise — buyer must approve the new plan.
 * Not recovered cash.
 *
 * IDEMPOTENCY NOTE: PayPal revise has no idempotency key / PayPal-Request-Id.
 * Re-calling Approve on a revise proposal may create another revise flow.
 * Only capture_outstanding uses PayPal-Request-Id (= proposal token short id).
 */
export async function reviseCheaperAction(
  subscriptionId: string,
  planId: string
) {
  const result = await reviseSubscription(subscriptionId, planId);
  const buyerApproveUrl = result.links?.find((l) => l.rel === "approve")?.href;
  return { result, buyerApproveUrl: buyerApproveUrl || null };
}
