import { NextResponse } from "next/server";
import {
  listRecoveredMrr,
  sumRecoveredUsd,
} from "@/lib/desk/recovered-mrr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recovered-MRR board — live PayPal transactions (COMPLETED gross ≥ $5).
 * Probe-informed: I-J8R13K0F76X4 → one $5 row (setup fee $1 excluded).
 */
export async function GET() {
  try {
    const rows = await listRecoveredMrr();
    return NextResponse.json({
      ok: true,
      totalUsd: sumRecoveredUsd(rows),
      count: rows.length,
      rows,
      note: "Live subscription transactions: COMPLETED USD gross ≥ $5 only. Setup-fee $1 excluded. Failures are not listed as txn status=FAILED.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
