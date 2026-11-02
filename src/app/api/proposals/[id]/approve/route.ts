import { NextResponse } from "next/server";
import { DEFAULT_POLICY, enforcePolicy } from "@/lib/policy/engine";
import {
  checkDemoPasscode,
  extractPasscode,
} from "@/lib/desk/passcode";
import {
  captureAmountExceedsOutstanding,
} from "@/lib/desk/proposal-token";
import { getProposal, updateProposal } from "@/lib/desk/proposals";
import { appendVerifiedRecovery } from "@/lib/desk/recovered-mrr";
import { getDeskSubscription } from "@/lib/desk/seed";
import { captureOutstandingAction } from "@/lib/recovery/capture";
import { reviseCheaperAction } from "@/lib/recovery/revise";
import type { Money } from "@/types/renewal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Merchant Approve → DEMO_PASSCODE → verify HMAC token → policy → capture/revise.
 * Capture uses PayPal-Request-Id = token short id.
 * Revise has NO idempotency key — see reviseCheaperAction docs.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      passcode?: string;
    };
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
        read.reason === "expired"
          ? 401
          : read.reason === "bad_sig" || read.reason === "tampered"
            ? 401
            : 400;
      return NextResponse.json(
        { error: "Invalid proposal token", reason: read.reason },
        { status }
      );
    }
    const stored = read.stored;

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

    if (
      captureAmountExceedsOutstanding(
        stored.proposal,
        sub.outstandingValue
      )
    ) {
      return NextResponse.json(
        {
          error: "Capture amount exceeds live outstanding",
          reason: "amount_exceeds_outstanding",
          outstanding: sub.outstanding,
          impact: stored.proposal.impact,
        },
        { status: 400 }
      );
    }

    const policy = enforcePolicy(stored.proposal, {
      outstanding: sub.outstanding,
      currentPlanPrice: sub.currentPlanPrice,
      ...DEFAULT_POLICY,
    });
    if (!policy.ok) {
      const next = updateProposal(token, { status: "BLOCKED", policy });
      return NextResponse.json(
        { error: "Policy re-check failed", reason: policy.reason, proposal: next },
        { status: 400 }
      );
    }

    const action = stored.proposal.action;
    const shortId = stored.id;

    if (action === "retry_later" || action === "escalate") {
      const next = updateProposal(token, {
        status: "APPROVED",
        result: {
          kind: action,
          note: "No money API called",
          fixtureLabeled: stored.proposal.fixtureLabeled ?? true,
        },
      });
      return NextResponse.json({
        ok: true,
        proposalId: next?.token,
        proposal: next,
      });
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
      const result = await captureOutstandingAction(
        sub.id,
        amount ?? undefined,
        undefined,
        { requestId: shortId }
      );
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
        const next = updateProposal(token, {
          result: {
            kind: "capture_outstanding",
            paypal: result,
            amount,
            subscriptionId: sub.id,
            outstandingAfter,
            verified: false,
            paypalRequestId: shortId,
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
            proposalId: next?.token,
            proposal: next,
          },
          { status: 502 }
        );
      }

      const amountForBoard: Money =
        amount ||
        sub.outstanding || {
          currency_code: "USD",
          value: "0.00",
        };

      const recoveredRow = appendVerifiedRecovery({
        subscriptionId: sub.id,
        pathKey: sub.key,
        amount: amountForBoard,
        paypal: result,
        proposalId: shortId,
        note: `Approve RECOVERED on ${sub.id}; outstanding cleared.`,
      });

      const next = updateProposal(token, {
        status: "APPROVED",
        result: {
          kind: "capture_outstanding",
          paypal: result,
          amount: amountForBoard,
          subscriptionId: sub.id,
          outstandingAfter,
          verified: true,
          recoveredMrrId: recoveredRow.id,
          paypalRequestId: shortId,
        },
      });
      return NextResponse.json({
        ok: true,
        deskStatus: "RECOVERED",
        recovered: recoveredRow,
        proposalId: next?.token,
        proposal: next,
      });
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
      // No PayPal-Request-Id — revise is not idempotent.
      const { result, buyerApproveUrl } = await reviseCheaperAction(
        sub.id,
        planId
      );
      const next = updateProposal(token, {
        status: "APPROVED",
        result: {
          kind: "revise_cheaper",
          paypal: result,
          buyerApproveUrl,
          framing: "retention / next-cycle price — not recovered cash",
          idempotency: "none — revise has no PayPal-Request-Id",
          subscriptionId: sub.id,
        },
      });
      return NextResponse.json({
        ok: true,
        deskStatus: "REVISED",
        buyerApproveUrl,
        proposalId: next?.token,
        proposal: next,
      });
    }

    return NextResponse.json({ error: `Unknown action ${action}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
