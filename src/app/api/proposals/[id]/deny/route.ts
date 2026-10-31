import { NextResponse } from "next/server";
import { getProposal, updateProposal } from "@/lib/desk/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Merchant Deny — no money API. */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const stored = getProposal(id);
  if (!stored) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }
  const next = updateProposal(id, {
    status: "DENIED",
    result: {
      reason: !stored.policy.ok
        ? stored.policy.reason
        : "Merchant denied proposal",
    },
  });
  return NextResponse.json({ ok: true, proposal: next });
}
