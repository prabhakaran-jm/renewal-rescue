import { NextResponse } from "next/server";
import {
  listRecoveredMrr,
  sumRecoveredUsd,
} from "@/lib/desk/recovered-mrr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Verified balance-recovery board — COMPLETED USD ≥ $5 with audited allowlist
 * or desk capture correlation (recomputed each call). Setup-fee $1 excluded.
 * Uncorrelated qualifying payments are completed_payment (excluded from total).
 * Optimistic / desk_approve rows may appear as Recovery pending and are
 * excluded from totalUsd.
 */
export async function GET() {
  try {
    const rows = await listRecoveredMrr();
    return NextResponse.json({
      ok: true,
      totalUsd: sumRecoveredUsd(rows),
      count: rows.filter(
        (r) =>
          r.source === "paypal_transactions" &&
          !r.pending &&
          r.attribution !== "completed_payment"
      ).length,
      rows,
      note: "Verified balance recovery: audited historical txn allowlist or desk Approve/capture correlation. Uncorrelated COMPLETED ≥ $5 labeled completed subscription payment. Recovery-pending / desk_approve excluded from totalUsd.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
