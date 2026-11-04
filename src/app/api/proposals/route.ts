import { NextResponse } from "next/server";
import { proposeForSubscription } from "@/lib/ai/propose";
import { saveProposal } from "@/lib/desk/proposals";
import { getDeskSubscription, preferredCaptureId } from "@/lib/desk/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { subscriptionId?, demoWriteOff?, forceRevise?, forceCapture? }
 * Returns HMAC-signed proposalId (Vercel-safe). Requires PROPOSAL_SIGNING_SECRET.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      subscriptionId?: string;
      demoWriteOff?: boolean;
      forceRevise?: boolean;
      forceCapture?: boolean;
    };

    const subscriptionId =
      body.subscriptionId?.trim() || preferredCaptureId();
    const sub = await getDeskSubscription(subscriptionId);
    if (!sub) {
      return NextResponse.json(
        { error: `Subscription ${subscriptionId} not in seed desk list` },
        { status: 404 }
      );
    }

    const { proposal, policy, ai, customerMessage } =
      await proposeForSubscription(sub, {
        demoWriteOff: Boolean(body.demoWriteOff),
        forceRevise: Boolean(body.forceRevise),
        forceCapture: Boolean(body.forceCapture),
      });
    const stored = saveProposal(proposal, policy);

    return NextResponse.json({
      proposalId: stored.token,
      requestId: stored.id,
      status: stored.status,
      expiresAt: stored.expiresAt,
      subscription: {
        id: sub.id,
        key: sub.key,
        status: sub.status,
        outstanding: sub.outstanding,
        preferredCaptureTarget: sub.preferredCaptureTarget,
        fixtureLabeled: sub.fixtureLabeled,
      },
      proposal: stored.proposal,
      policy: stored.policy,
      ai,
      customerMessage: customerMessage ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("PROPOSAL_SIGNING_SECRET") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
