import { NextResponse } from "next/server";
import {
  listDeskSubscriptions,
  preferredCaptureId,
} from "@/lib/desk/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — 4 seeded subs + live PayPal refresh */
export async function GET() {
  try {
    const subscriptions = await listDeskSubscriptions();
    return NextResponse.json({
      preferredCaptureId: preferredCaptureId(),
      count: subscriptions.length,
      note: "Live Billing GET. Webhooks Simulator is never money proof. Fixture only when outstanding is $0 and no first COMPLETED ≥ $5 recovery txn.",
      subscriptions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
