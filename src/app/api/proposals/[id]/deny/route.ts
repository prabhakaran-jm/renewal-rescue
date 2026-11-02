import { NextResponse } from "next/server";
import { getProposal, updateProposal } from "@/lib/desk/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Merchant Deny — verify HMAC token; no money API. */
export async function POST(_req: Request, ctx: Ctx) {
  const { id: rawId } = await ctx.params;
  const token = decodeURIComponent(rawId);
  const read = getProposal(token);
  if (!read.ok) {
    const status =
      read.reason === "expired" ||
      read.reason === "bad_sig" ||
      read.reason === "tampered"
        ? 401
        : 400;
    return NextResponse.json(
      { error: "Invalid proposal token", reason: read.reason },
      { status }
    );
  }
  const stored = read.stored;
  const next = updateProposal(token, {
    status: "DENIED",
    result: {
      reason: !stored.policy.ok
        ? stored.policy.reason
        : "Merchant denied proposal",
    },
  });
  return NextResponse.json({
    ok: true,
    proposalId: next?.token,
    proposal: next,
  });
}
