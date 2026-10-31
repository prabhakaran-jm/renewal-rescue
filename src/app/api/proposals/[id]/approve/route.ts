import { NextResponse } from "next/server";
import { DEFAULT_POLICY, enforcePolicy } from "@/lib/policy/engine";
import { getProposal, updateProposal } from "@/lib/desk/proposals";
import { getDeskSubscription } from "@/lib/desk/seed";
import { captureOutstandingAction } from "@/lib/recovery/capture";
import { reviseCheaperAction } from "@/lib/recovery/revise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Merchant Approve → policy re-check → capture/revise.
 * Capture runs ONLY when outstanding > 0.
 * Never auto-called from list/propose — explicit Approve only.
 * Step 6 films live money proof; Step 5 wires the path.
 */
export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const stored = getProposal(id);
    if (!stored) {
      return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    }
    if (!stored.policy.ok) {
      return NextResponse.json(
        {
          error: "Proposal blocked by policy",
          reason: !stored.policy.ok ? stored.policy.reason : undefined,
        },
        { status: 400 }
      );
    }
    if (stored.status === "APPROVED") {
      return NextResponse.json(
        { error: "Already approved (idempotent)", proposal: stored },
        { status: 409 }
      );
    }

    const sub = await getDeskSubscription(stored.proposal.subscriptionId);
    if (!sub) {
      return NextResponse.json(
        { error: "Subscription not on desk" },
        { status: 404 }
      );
    }

    // Re-check policy against live outstanding
    const policy = enforcePolicy(stored.proposal, {
      outstanding: sub.outstanding,
      currentPlanPrice: sub.currentPlanPrice,
      ...DEFAULT_POLICY,
    });
    if (!policy.ok) {
      updateProposal(id, { status: "BLOCKED", policy });
      return NextResponse.json(
        { error: "Policy re-check failed", reason: policy.reason },
        { status: 400 }
      );
    }

    const action = stored.proposal.action;

    if (action === "retry_later" || action === "escalate") {
      const next = updateProposal(id, {
        status: "APPROVED",
        result: {
          kind: action,
          note: "No money API called",
          fixtureLabeled: stored.proposal.fixtureLabeled ?? true,
        },
      });
      return NextResponse.json({ ok: true, proposal: next });
    }

    if (action === "capture_outstanding") {
      if (!(sub.outstandingValue > 0)) {
        return NextResponse.json(
          {
            error:
              "Refuse capture: outstanding is $0. Real capture only when outstanding > 0.",
          },
          { status: 400 }
        );
      }
      const amount = stored.proposal.impact || sub.outstanding || undefined;
      const result = await captureOutstandingAction(sub.id, amount ?? undefined);
      // Money proof: re-GET live outstanding. Empty/async PayPal 2xx must not
      // claim RECOVERED while balance still shows (e.g. CAPTURE_IN_PROGRESS).
      const after = await getDeskSubscription(sub.id);
      const outstandingAfter = after?.outstanding ?? null;
      const cleared = (after?.outstandingValue ?? 0) <= 0;
      const emptyOrPending =
        result == null ||
        (typeof result === "object" &&
          result !== null &&
          "status" in result &&
          (result as { status?: string }).status === "NO_CONTENT");

      if (!cleared) {
        const next = updateProposal(id, {
          result: {
            kind: "capture_outstanding",
            paypal: result,
            amount,
            subscriptionId: sub.id,
            outstandingAfter,
            verified: false,
          },
        });
        return NextResponse.json(
          {
            ok: false,
            error: emptyOrPending
              ? "PayPal capture returned empty/pending body and outstanding is still > 0 — not money proof"
              : "PayPal capture response received but outstanding balance still > 0 — not money proof",
            deskStatus: "CAPTURE_PEND",
            paypal: result,
            outstandingAfter,
            proposal: next,
          },
          { status: 502 }
        );
      }

      const next = updateProposal(id, {
        status: "APPROVED",
        result: {
          kind: "capture_outstanding",
          paypal: result,
          amount,
          subscriptionId: sub.id,
          outstandingAfter,
          verified: true,
        },
      });
      return NextResponse.json({ ok: true, deskStatus: "RECOVERED", proposal: next });
    }

    if (action === "revise_cheaper") {
      const planId =
        stored.proposal.proposedPlanId ||
        process.env.REVISE_CHEAPER_PLAN_ID?.trim();
      if (!planId) {
        return NextResponse.json(
          {
            error:
              "Revise requires proposedPlanId or REVISE_CHEAPER_PLAN_ID (cheaper ACTIVE plan).",
          },
          { status: 400 }
        );
      }
      const { result, buyerApproveUrl } = await reviseCheaperAction(
        sub.id,
        planId
      );
      const next = updateProposal(id, {
        status: "APPROVED",
        result: {
          kind: "revise_cheaper",
          paypal: result,
          buyerApproveUrl,
          framing: "retention / next-cycle price — not recovered cash",
          subscriptionId: sub.id,
        },
      });
      return NextResponse.json({
        ok: true,
        deskStatus: "REVISED",
        buyerApproveUrl,
        proposal: next,
      });
    }

    return NextResponse.json({ error: `Unknown action ${action}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
