import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PolicyResult, RenewalProposal } from "@/types/renewal";

/** Default proposal token lifetime (Vercel-safe; no server Map). */
export const PROPOSAL_TOKEN_TTL_MS = 30 * 60 * 1000;

export type ProposalTokenStatus =
  | "PROPOSED"
  | "BLOCKED"
  | "APPROVED"
  | "DENIED";

export type ProposalClaims = {
  v: 1;
  /** Short id — also used as PayPal-Request-Id on capture */
  id: string;
  iat: number;
  exp: number;
  proposal: RenewalProposal;
  policy: PolicyResult;
  status: ProposalTokenStatus;
  result?: unknown;
};

export type VerifyFailReason =
  | "missing_secret"
  | "malformed"
  | "bad_sig"
  | "tampered"
  | "expired";

function requireSecret(): string {
  const s = process.env.PROPOSAL_SIGNING_SECRET?.trim();
  if (!s) {
    throw new Error(
      "PROPOSAL_SIGNING_SECRET not set. Add it to .env / Vercel env (never commit)."
    );
  }
  return s;
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function hmacSign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function newProposalId(): string {
  return `prop_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export type MintInput = {
  proposal: RenewalProposal;
  policy: PolicyResult;
  status?: ProposalTokenStatus;
  result?: unknown;
  /** Preserve short id across re-signs (Approve / Deny) */
  id?: string;
  ttlMs?: number;
  nowMs?: number;
  secret?: string;
};

/** Sign proposal claims into `<payload>.<sig>` (secret never in token). */
export function mintProposalToken(input: MintInput): {
  token: string;
  claims: ProposalClaims;
} {
  const secret = input.secret ?? requireSecret();
  const now = input.nowMs ?? Date.now();
  const ttl = input.ttlMs ?? PROPOSAL_TOKEN_TTL_MS;
  const claims: ProposalClaims = {
    v: 1,
    id: input.id || newProposalId(),
    iat: now,
    exp: now + ttl,
    proposal: input.proposal,
    policy: input.policy,
    status: input.status ?? (input.policy.ok ? "PROPOSED" : "BLOCKED"),
    result: input.result,
  };
  const payloadB64 = b64urlJson(claims);
  const sig = hmacSign(payloadB64, secret);
  return { token: `${payloadB64}.${sig}`, claims };
}

export type VerifyOk = { ok: true; claims: ProposalClaims };
export type VerifyFail = { ok: false; reason: VerifyFailReason };
export type VerifyResult = VerifyOk | VerifyFail;

/**
 * Verify HMAC token. Detects malformed, bad signature, expired, and
 * payload tampering (sig mismatch after rewrite).
 */
export function verifyProposalToken(
  token: string,
  opts: { nowMs?: number; secret?: string } = {}
): VerifyResult {
  let secret: string;
  try {
    secret = opts.secret ?? requireSecret();
  } catch {
    return { ok: false, reason: "missing_secret" };
  }

  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }

  const lastDot = token.lastIndexOf(".");
  const payloadB64 = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!payloadB64 || !sig) return { ok: false, reason: "malformed" };

  const expected = hmacSign(payloadB64, secret);
  if (!safeEqualStr(sig, expected)) {
    return { ok: false, reason: "bad_sig" };
  }

  let claims: ProposalClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as ProposalClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    !claims ||
    claims.v !== 1 ||
    typeof claims.id !== "string" ||
    typeof claims.exp !== "number" ||
    !claims.proposal ||
    !claims.policy
  ) {
    return { ok: false, reason: "tampered" };
  }

  const now = opts.nowMs ?? Date.now();
  if (now > claims.exp) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims };
}

/**
 * Capture amount must be ≤ live outstanding (token may predate a partial pay).
 */
export function captureAmountExceedsOutstanding(
  proposal: RenewalProposal,
  outstandingValue: number
): boolean {
  if (proposal.action !== "capture_outstanding") return false;
  if (!(outstandingValue > 0)) return true;
  if (!proposal.impact) return false;
  const amount = Number.parseFloat(proposal.impact.value);
  if (!Number.isFinite(amount)) return true;
  return amount > outstandingValue + 1e-9;
}
