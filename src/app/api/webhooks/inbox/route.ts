import { NextResponse } from "next/server";
import { listWebhookInbox } from "@/lib/desk/webhook-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent verified webhook events for the desk inbox. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("limit") || 40) || 40)
    );
    const events = listWebhookInbox(limit);
    return NextResponse.json({
      ok: true,
      count: events.length,
      events,
      note: "Signature-verified events only. Never treat as money proof.",
      webhookConfigured: Boolean(process.env.PAYPAL_WEBHOOK_ID?.trim()),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
