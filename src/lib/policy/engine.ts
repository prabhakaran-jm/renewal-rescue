import type {
  Money,
  PolicyContext,
  PolicyResult,
  RenewalProposal,
} from "@/types/renewal";

function toNumber(m: Money): number {
  return Number.parseFloat(m.value);
}

/**
 * Deterministic policy gate — floors, revise caps, write-off ban,
 * capture amount ≤ outstanding and ≥ minCapturePct of outstanding.
 */
export function enforcePolicy(
  proposal: RenewalProposal,
  ctx: PolicyContext
): PolicyResult {
  const action = (proposal as { action: string }).action;

  if (action === "write_off") {
    return { ok: false, reason: "Write-offs are banned by policy." };
  }

  if (proposal.action === "escalate" || proposal.action === "retry_later") {
    return { ok: true };
  }

  if (proposal.action === "capture_outstanding") {
    if (!ctx.outstanding || toNumber(ctx.outstanding) <= 0) {
      return { ok: false, reason: "No outstanding balance to capture." };
    }
    const outstanding = toNumber(ctx.outstanding);
    const amount = proposal.impact ? toNumber(proposal.impact) : outstanding;
    if (!(amount > 0)) {
      return { ok: false, reason: "Capture amount must be greater than 0." };
    }
    if (amount > outstanding + 1e-9) {
      return {
        ok: false,
        reason: `Capture ${amount} exceeds outstanding ${outstanding}.`,
      };
    }
    const pct = (amount / outstanding) * 100;
    if (pct + 1e-9 < ctx.minCapturePct) {
      return {
        ok: false,
        reason: `Capture ${pct.toFixed(0)}% is below min ${ctx.minCapturePct}% of outstanding.`,
      };
    }
    return { ok: true };
  }

  if (proposal.action === "revise_cheaper") {
    if (!proposal.proposedPrice) {
      return { ok: false, reason: "Revise requires a proposed price." };
    }
    const current = toNumber(ctx.currentPlanPrice);
    const next = toNumber(proposal.proposedPrice);
    if (!(next > 0) || !(current > 0)) {
      return { ok: false, reason: "Invalid plan prices." };
    }
    if (ctx.allowWriteOff === false && next === 0) {
      return { ok: false, reason: "Zero-price revise is a write-off; blocked." };
    }
    if (next >= current) {
      return { ok: false, reason: "Revise must be cheaper than current plan." };
    }
    const discountPct = ((current - next) / current) * 100;
    if (discountPct > ctx.maxDiscountPct + 1e-9) {
      return {
        ok: false,
        reason: `Discount ${discountPct.toFixed(0)}% exceeds max ${ctx.maxDiscountPct}%.`,
      };
    }
    return { ok: true };
  }

  return { ok: false, reason: `Unknown action: ${action}` };
}

export const DEFAULT_POLICY = {
  minCapturePct: 50,
  maxDiscountPct: 30,
  allowWriteOff: false as const,
};
