import { NextResponse } from "next/server";
import {
  listRecoveredMrr,
  sumRecoveredUsd,
} from "@/lib/desk/recovered-mrr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recovered-MRR board — seed money-proof + desk recovery log only.
 * Never invents MRR.
 */
export async function GET() {
  try {
    const rows = listRecoveredMrr();
    return NextResponse.json({
      ok: true,
      totalUsd: sumRecoveredUsd(rows),
      count: rows.length,
      rows,
      note: "Only verified PayPal-backed recoveries (money-proof seed + Approve RECOVERED). Do not invent MRR.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
