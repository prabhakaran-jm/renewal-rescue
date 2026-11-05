/**
 * Desk copy for Approve results that do not move money,
 * and Capture now override hint (action + AI provenance aware).
 */

export type NoMoneyApproveAction = "retry_later" | "escalate";

export type AiSourceLabel = "gemini" | "fallback" | "rule" | string;

export function isNoMoneyApproveAction(
  action: string
): action is NoMoneyApproveAction {
  return action === "retry_later" || action === "escalate";
}

/** Neutral success copy when merchant Approves retry_later / escalate. */
export function noMoneyApproveMessage(action: NoMoneyApproveAction): string {
  if (action === "retry_later") {
    return "Approved: no money moved — marked retry later (no PayPal call)";
  }
  return "Approved: no money moved — flagged for escalation (no PayPal call)";
}

/**
 * Show Capture now override when propose did not pick capture,
 * live outstanding remains, and policy is not blocked.
 */
export function shouldShowCaptureNow(opts: {
  outstandingValue: number;
  proposalAction: string | null | undefined;
  /** When false, hide Capture now (e.g. Deny / write-off blocked). */
  policyOk?: boolean;
}): boolean {
  if (!(opts.outstandingValue > 0)) return false;
  if (!opts.proposalAction) return false;
  if (opts.policyOk === false) return false;
  return opts.proposalAction !== "capture_outstanding";
}

function sourcePhrase(source: AiSourceLabel | undefined): string {
  if (source === "gemini") return "Gemini";
  if (source === "rule") return "RULE";
  return "Fallback";
}

/**
 * Hint next to Capture now — reflects current action + ai.source.
 * Uses Gemini provenance when ai.source is gemini (even if a separate RULE
 * warning block is shown for SUSPENDED retry_later honesty). Never say
 * “RULE recommends…” solely because ruleWarning is present.
 * e.g. "Gemini recommends retry_later. Merchant can override and capture the 6.00 USD outstanding now."
 */
export function captureNowHint(opts: {
  action: string;
  aiSource?: AiSourceLabel | null;
  outstandingValue: number;
  currencyCode?: string | null;
}): string {
  const currency = (opts.currencyCode || "USD").trim() || "USD";
  const amount = `${opts.outstandingValue.toFixed(2)} ${currency}`;
  const who = sourcePhrase(opts.aiSource || "fallback");
  return `${who} recommends ${opts.action}. Merchant can override and capture the ${amount} outstanding now.`;
}
