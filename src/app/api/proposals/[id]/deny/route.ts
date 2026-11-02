import { NextResponse } from "next/server";
import {
  checkDemoPasscode,
  extractPasscode,
} from "@/lib/desk/passcode";
import { getProposal, updateProposal } from "@/lib/desk/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Merchant Deny — DEMO_PASSCODE + HMAC token; no money API. */
export async function POST(req: Request, ctx: Ctx) {
  const body = (await req.json().catch(() => ({}))) as { passcode?: string };
  const pass = checkDemoPasscode(
    extractPasscode(body, req.headers.get("x-demo-passcode"))
  );
  if (!pass.ok) {
    if (pass.reason === "missing_env") {
      return NextResponse.json(
        { error: "DEMO_PASSCODE not configured", reason: pass.reason },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Invalid demo passcode", reason: pass.reason },
      { status: 401 }
    );
  }

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
