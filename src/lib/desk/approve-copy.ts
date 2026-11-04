/**
 * Desk copy for Approve results that do not move money.
 * Visible in the Approve / Deny result panel — not an error path.
 */

export type NoMoneyApproveAction = "retry_later" | "escalate";

export function isNoMoneyApproveAction(
  action: string
): action is NoMoneyApproveAction {
  return action === "retry_later" || action === "escalate";
}

/** Neutral success copy when merchant Approves retry_later / escalate. */
export function noMoneyApproveMessage(action: NoMoneyApproveAction): string {
  if (action === "retry_later") {
    return "Approved: no money moved — retry scheduled by merchant";
  }
  return "Approved: no money moved — escalated by merchant";
}

/**
 * Show Capture now override when Gemini (or any propose) did not pick capture
 * and live outstanding remains — film: AI suggests waiting, merchant overrides.
 */
export function shouldShowCaptureNow(opts: {
  outstandingValue: number;
  proposalAction: string | null | undefined;
}): boolean {
  if (!(opts.outstandingValue > 0)) return false;
  if (!opts.proposalAction) return false;
  return opts.proposalAction !== "capture_outstanding";
}
