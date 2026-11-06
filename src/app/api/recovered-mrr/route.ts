import { NextResponse } from "next/server";
import {
  listRecoveredMrr,
  sumRecoveredUsd,
} from "@/lib/desk/recovered-mrr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Verified balance-recovery board — first COMPLETED USD ≥ $5 per subscription
 * from the live txn list (recomputed each call). Setup-fee $1 excluded.
 * Optimistic / desk_approve rows may appear as Recovery pending and are
 * excluded from totalUsd.
 */
export async function GET() {
  try {
    const rows = await listRecoveredMrr();
    return NextResponse.json({
      ok: true,
      totalUsd: sumRecoveredUsd(rows),
      count: rows.filter((r) => r.source === "paypal_transactions" && !r.pending)
        .length,
      rows,
      note: "Verified balance recovery: first COMPLETED USD ≥ $5 per subscription from live txn list. Undercounts double recoveries. Recovery-pending / desk_approve rows excluded from totalUsd.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
