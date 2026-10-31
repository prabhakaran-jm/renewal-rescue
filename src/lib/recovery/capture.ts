import { captureOutstanding } from "@/lib/paypal/billing";
import type { Money } from "@/types/renewal";

/**
 * Thin wrapper — Approve route is the only caller.
 * Webhooks Simulator is never money proof.
 */
export async function captureOutstandingAction(
  subscriptionId: string,
  amount: Money | undefined,
  note = "Renewal Rescue merchant-approved outstanding capture"
) {
  return captureOutstanding(subscriptionId, note, amount);
}
