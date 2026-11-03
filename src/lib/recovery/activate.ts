import { activateSubscription } from "@/lib/paypal/billing";

/**
 * Thin wrapper — Approve settle path only (after outstanding clears).
 * Treats already-ACTIVE as success so re-settle is safe.
 */
export async function activateAfterCaptureAction(
  subscriptionId: string,
  reason?: string
): Promise<{
  ok: boolean;
  alreadyActive?: boolean;
  paypal?: unknown;
  error?: string;
}> {
  try {
    const paypal = await activateSubscription(subscriptionId, reason);
    return { ok: true, paypal };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err && typeof err === "object" && "status" in err
        ? Number((err as { status?: number }).status)
        : undefined;
    // PayPal often 422 when already ACTIVE
    if (
      status === 422 ||
      /already.*active/i.test(message) ||
      /subscription.*active/i.test(message)
    ) {
      return { ok: true, alreadyActive: true, error: message };
    }
    return { ok: false, error: message };
  }
}
