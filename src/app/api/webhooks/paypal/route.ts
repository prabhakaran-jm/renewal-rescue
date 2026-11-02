import { NextResponse } from "next/server";
import { paypalFetch } from "@/lib/paypal/client";
import {
  verifyPaypalWebhook,
  type WebhookHeaders,
} from "@/lib/paypal/webhook-verifier";
import {
  INTERESTING_EVENTS,
  appendWebhookEvent,
  extractResourceId,
  hasSeenEvent,
} from "@/lib/desk/webhook-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Verified PayPal webhooks.
 * Requires PAYPAL_WEBHOOK_ID + transmission headers.
 * Simulator = optional smoke only — never money proof.
 */
export async function POST(req: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId) {
    return NextResponse.json(
      {
        error:
          "PAYPAL_WEBHOOK_ID not set. Create a sandbox webhook pointing at your public tunnel, then set the id in .env (never commit .env).",
        blocker: true,
      },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const headers: WebhookHeaders = {
    "paypal-auth-algo": req.headers.get("paypal-auth-algo") || undefined,
    "paypal-cert-url": req.headers.get("paypal-cert-url") || undefined,
    "paypal-transmission-id":
      req.headers.get("paypal-transmission-id") || undefined,
    "paypal-transmission-sig":
      req.headers.get("paypal-transmission-sig") || undefined,
    "paypal-transmission-time":
      req.headers.get("paypal-transmission-time") || undefined,
  };

  let verify: { ok: true } | { ok: false; reason: string };
  try {
    verify = await verifyPaypalWebhook({
      headers,
      webhookId,
      body,
      verifyWithPayPal: (payload) =>
        paypalFetch<{ verification_status: string }>(
          "/v1/notifications/verify-webhook-signature",
          { method: "POST", body: payload }
        ),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verify call failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!verify.ok) {
    return NextResponse.json(
      { error: "Invalid signature", reason: verify.reason },
      { status: 401 }
    );
  }

  const event = body as {
    id?: string;
    event_type?: string;
    resource?: unknown;
  };
  const eventId = event.id ?? null;
  const eventType = event.event_type ?? null;
  const duplicate = hasSeenEvent(eventId);
  const interesting = eventType ? INTERESTING_EVENTS.has(eventType) : false;

  const record = appendWebhookEvent({
    receivedAt: new Date().toISOString(),
    transmissionId: headers["paypal-transmission-id"] ?? null,
    eventId,
    eventType,
    resourceId: extractResourceId(body),
    duplicate,
    verification: "SUCCESS",
    interesting,
    moneyProof: false,
    note: "Verified signature stored — Simulator OK for smoke only; Billing GET outstanding is the DECIDE / money signal",
    summary: {
      event_type: eventType,
      resource_id: extractResourceId(body),
    },
  });

  return NextResponse.json({
    ok: true,
    duplicate,
    interesting,
    moneyProof: false,
    eventId,
    eventType,
    stored: record,
  });
}
