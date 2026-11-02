import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  captureAmountExceedsOutstanding,
  mintProposalToken,
  verifyProposalToken,
} from "../src/lib/desk/proposal-token.ts";
import type { RenewalProposal } from "../src/types/renewal.ts";

const SECRET = "test-proposal-signing-secret-not-real";

const proposal: RenewalProposal = {
  subscriptionId: "I-3HK9STH33F7F",
  action: "capture_outstanding",
  rationale: "Capture live outstanding after merchant approve only",
  impact: { currency_code: "USD", value: "5.00" },
};

before(() => {
  process.env.PROPOSAL_SIGNING_SECRET = SECRET;
});

describe("proposal HMAC tokens", () => {
  it("mints and verifies a valid token", () => {
    const { token, claims } = mintProposalToken({
      proposal,
      policy: { ok: true },
      secret: SECRET,
      nowMs: 1_000_000,
      ttlMs: 60_000,
    });
    const v = verifyProposalToken(token, { secret: SECRET, nowMs: 1_010_000 });
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.claims.id, claims.id);
      assert.equal(v.claims.proposal.subscriptionId, "I-3HK9STH33F7F");
      assert.equal(v.claims.proposal.impact?.value, "5.00");
    }
  });

  it("rejects bad signature", () => {
    const { token } = mintProposalToken({
      proposal,
      policy: { ok: true },
      secret: SECRET,
    });
    const [payload] = token.split(".");
    const v = verifyProposalToken(`${payload}.AAAAAAAAAAAAAAAAAAAAAA`, {
      secret: SECRET,
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "bad_sig");
  });

  it("rejects tampered payload (rewritten claims, old sig)", () => {
    const { token } = mintProposalToken({
      proposal,
      policy: { ok: true },
      secret: SECRET,
    });
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const claims = JSON.parse(
      Buffer.from(token.slice(0, token.lastIndexOf(".")), "base64url").toString(
        "utf8"
      )
    ) as { proposal: RenewalProposal };
    claims.proposal.impact = { currency_code: "USD", value: "99.00" };
    const tamperedPayload = Buffer.from(
      JSON.stringify(claims),
      "utf8"
    ).toString("base64url");
    const v = verifyProposalToken(`${tamperedPayload}.${sig}`, {
      secret: SECRET,
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "bad_sig");
  });

  it("rejects expired token", () => {
    const { token } = mintProposalToken({
      proposal,
      policy: { ok: true },
      secret: SECRET,
      nowMs: 1_000_000,
      ttlMs: 1_000,
    });
    const v = verifyProposalToken(token, {
      secret: SECRET,
      nowMs: 1_002_000,
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "expired");
  });

  it("flags amount > outstanding", () => {
    assert.equal(
      captureAmountExceedsOutstanding(proposal, 5),
      false
    );
    assert.equal(
      captureAmountExceedsOutstanding(proposal, 4.99),
      true
    );
    assert.equal(
      captureAmountExceedsOutstanding(
        {
          ...proposal,
          impact: { currency_code: "USD", value: "10.00" },
        },
        5
      ),
      true
    );
  });
});
