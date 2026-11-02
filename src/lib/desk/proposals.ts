import {
  mintProposalToken,
  verifyProposalToken,
  type ProposalClaims,
  type ProposalTokenStatus,
} from "@/lib/desk/proposal-token";
import type { PolicyResult, RenewalProposal } from "@/types/renewal";

export type StoredProposal = {
  /** Full HMAC token — use as proposalId in API paths */
  token: string;
  /** Short id (PayPal-Request-Id on capture) */
  id: string;
  createdAt: string;
  expiresAt: string;
  proposal: RenewalProposal;
  policy: PolicyResult;
  status: ProposalTokenStatus;
  result?: unknown;
};

function claimsToStored(token: string, claims: ProposalClaims): StoredProposal {
  return {
    token,
    id: claims.id,
    createdAt: new Date(claims.iat).toISOString(),
    expiresAt: new Date(claims.exp).toISOString(),
    proposal: claims.proposal,
    policy: claims.policy,
    status: claims.status,
    result: claims.result,
  };
}

/**
 * Mint a signed proposal token (Vercel-safe — no globalThis Map).
 * Requires PROPOSAL_SIGNING_SECRET.
 */
export function saveProposal(
  proposal: RenewalProposal,
  policy: PolicyResult
): StoredProposal {
  const { token, claims } = mintProposalToken({ proposal, policy });
  return claimsToStored(token, claims);
}

export type GetProposalResult =
  | { ok: true; stored: StoredProposal }
  | {
      ok: false;
      reason: "malformed" | "bad_sig" | "tampered" | "expired" | "missing_secret";
    };

/** Verify token and return stored shape. */
export function getProposal(tokenOrId: string): GetProposalResult {
  const verified = verifyProposalToken(tokenOrId);
  if (!verified.ok) return verified;
  return { ok: true, stored: claimsToStored(tokenOrId, verified.claims) };
}

/**
 * Re-sign with patched status/result (same short id).
 * Returns null when the incoming token is invalid.
 */
export function updateProposal(
  token: string,
  patch: Partial<Pick<StoredProposal, "status" | "result" | "policy">>
): StoredProposal | null {
  const verified = verifyProposalToken(token);
  if (!verified.ok) return null;
  const c = verified.claims;
  const { token: nextToken, claims } = mintProposalToken({
    id: c.id,
    proposal: c.proposal,
    policy: patch.policy ?? c.policy,
    status: patch.status ?? c.status,
    result: patch.result !== undefined ? patch.result : c.result,
    nowMs: Date.now(),
    // Preserve remaining TTL window from original iat/exp when possible
    ttlMs: Math.max(60_000, c.exp - Date.now()),
  });
  return claimsToStored(nextToken, claims);
}
