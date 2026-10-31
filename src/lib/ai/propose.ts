import { RenewalProposalSchema } from "@/lib/ai/schema";
import { DEFAULT_POLICY, enforcePolicy } from "@/lib/policy/engine";
import type {
  DeskSubscription,
  PolicyResult,
  RenewalProposal,
} from "@/types/renewal";

function money(value: number, currency = "USD") {
  return { currency_code: currency, value: value.toFixed(2) };
}

type ProposeOpts = {
  /** Demo deny beat: attempt banned write-off */
  demoWriteOff?: boolean;
  /** Force revise retention path (still FIXTURE if outstanding is $0) */
  forceRevise?: boolean;
  revisePlanId?: string;
};

/**
 * Deterministic propose for Step 5 MVP (no LLM required).
 * - outstanding > 0 → capture_outstanding (live; prefer preferredCaptureTarget)
 * - outstanding = 0 → retry_later labeled FIXTURE (not verified recovery)
 * Merchant Approve is required before any money API — never auto-capture.
 */
export function proposeForSubscription(
  sub: DeskSubscription,
  opts: ProposeOpts = {}
): {
  proposal: RenewalProposal;
  policy: PolicyResult;
} {
  const outstanding = sub.outstandingValue;
  const currency = sub.outstanding?.currency_code || "USD";
  const ctx = {
    outstanding: sub.outstanding,
    currentPlanPrice: sub.currentPlanPrice,
    ...DEFAULT_POLICY,
  };

  if (opts.demoWriteOff) {
    const fake = {
      subscriptionId: sub.id,
      action: "write_off" as const,
      rationale: "DEMO DENY: request full write-off / forgive outstanding.",
      impact: money(0, currency),
      fixtureLabeled: true,
    };
    const policy = enforcePolicy(
      fake as unknown as RenewalProposal,
      ctx
    );
    return {
      proposal: {
        subscriptionId: sub.id,
        action: "escalate",
        rationale: `Write-off refused: ${!policy.ok ? policy.reason : "banned"}`,
        fixtureLabeled: true,
      },
      policy,
    };
  }

  let raw: RenewalProposal;

  if (outstanding > 0 && !opts.forceRevise) {
    raw = {
      subscriptionId: sub.id,
      action: "capture_outstanding",
      rationale: sub.preferredCaptureTarget
        ? `Preferred live capture target ${sub.id}: outstanding ${outstanding} ${currency} (${sub.status}). Capture OUTSTANDING_BALANCE only after merchant Approve - never auto-capture.`
        : `Live outstanding ${outstanding} ${currency}. Propose capture <= outstanding; merchant must Approve before money moves.`,
      impact: money(outstanding, currency),
      fixtureLabeled: false,
    };
  } else if (opts.forceRevise || (outstanding <= 0 && opts.forceRevise)) {
    const current = Number.parseFloat(sub.currentPlanPrice.value);
    const next = Number((current * 0.7).toFixed(2));
    raw = {
      subscriptionId: sub.id,
      action: "revise_cheaper",
      rationale:
        outstanding > 0
          ? "Retention revise: cheaper plan next cycle (buyer must approve). Not recovered cash."
          : "FIXTURE: no outstanding - retention revise demo only (buyer approve URL). Not verified recovery.",
      proposedPlanId:
        opts.revisePlanId || process.env.REVISE_CHEAPER_PLAN_ID || undefined,
      proposedPrice: money(next),
      impact: money(next),
      fixtureLabeled: !(outstanding > 0),
    };
  } else {
    raw = {
      subscriptionId: sub.id,
      action: "retry_later",
      rationale:
        "FIXTURE: outstanding is $0 - not verified PayPal recovery. Wait for failed-renewal lifecycle; do not claim Simulator or fixtures as money proof.",
      fixtureLabeled: true,
    };
  }

  const proposal = RenewalProposalSchema.parse(raw) as RenewalProposal;
  const policy = enforcePolicy(proposal, ctx);
  return { proposal, policy };
}
