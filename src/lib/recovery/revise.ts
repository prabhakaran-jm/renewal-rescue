import { reviseSubscription } from "@/lib/paypal/billing";

/**
 * Revise cheaper → retention / next-cycle price. Returns buyer approve URL.
 * Not recovered cash.
 */
export async function reviseCheaperAction(
  subscriptionId: string,
  cheaperPlanId: string
) {
  const result = await reviseSubscription(subscriptionId, cheaperPlanId);
  const approve = result.links?.find((l) => l.rel === "approve");
  return {
    result,
    buyerApproveUrl: approve?.href ?? null,
  };
}
