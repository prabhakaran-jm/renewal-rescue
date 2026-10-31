import { NextResponse } from "next/server";
import { proposeForSubscription } from "@/lib/ai/propose";
import { saveProposal } from "@/lib/desk/proposals";
import { getDeskSubscription, preferredCaptureId } from "@/lib/desk/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { subscriptionId?, demoWriteOff?, forceRevise? }
 * Defaults to preferred live capture id when outstanding path is intended.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      subscriptionId?: string;
      demoWriteOff?: boolean;
      forceRevise?: boolean;
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

    const { proposal, policy } = proposeForSubscription(sub, {
      demoWriteOff: Boolean(body.demoWriteOff),
      forceRevise: Boolean(body.forceRevise),
    });
    const stored = saveProposal(proposal, policy);

    return NextResponse.json({
      proposalId: stored.id,
      status: stored.status,
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
