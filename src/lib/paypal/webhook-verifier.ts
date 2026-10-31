/**
 * PayPal webhook signature check — wire to POST /api/webhooks/paypal.
 * Simulator OK for UI wiring only — never as filmed money proof.
 *
 * Production pattern: PayPal verify-webhook-signature API with
 * PAYPAL_WEBHOOK_ID + transmission headers from the request.
 */

export type WebhookHeaders = {
  "paypal-auth-algo"?: string;
  "paypal-cert-url"?: string;
  "paypal-transmission-id"?: string;
  "paypal-transmission-sig"?: string;
  "paypal-transmission-time"?: string;
};

export type VerifyInput = {
  headers: WebhookHeaders;
  webhookId: string;
  body: unknown;
  /** Injected: calls POST /v1/notifications/verify-webhook-signature */
  verifyWithPayPal: (payload: {
    auth_algo: string;
    cert_url: string;
    transmission_id: string;
    transmission_sig: string;
    transmission_time: string;
    webhook_id: string;
    webhook_event: unknown;
  }) => Promise<{ verification_status: string }>;
};

export async function verifyPaypalWebhook(
  input: VerifyInput
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const h = input.headers;
  const required = [
    h["paypal-auth-algo"],
    h["paypal-cert-url"],
    h["paypal-transmission-id"],
    h["paypal-transmission-sig"],
    h["paypal-transmission-time"],
  ];
  if (required.some((v) => !v)) {
    return { ok: false, reason: "Missing PayPal transmission headers." };
  }

  const result = await input.verifyWithPayPal({
    auth_algo: h["paypal-auth-algo"]!,
    cert_url: h["paypal-cert-url"]!,
    transmission_id: h["paypal-transmission-id"]!,
    transmission_sig: h["paypal-transmission-sig"]!,
    transmission_time: h["paypal-transmission-time"]!,
    webhook_id: input.webhookId,
    webhook_event: input.body,
  });

  if (result.verification_status !== "SUCCESS") {
    return { ok: false, reason: `Verification ${result.verification_status}` };
  }
  return { ok: true };
}

/** Idempotency helper — skip if event id already stored */
export function shouldProcessEvent(
  eventId: string,
  seenIds: Set<string>
): boolean {
  if (seenIds.has(eventId)) return false;
  seenIds.add(eventId);
  return true;
}
