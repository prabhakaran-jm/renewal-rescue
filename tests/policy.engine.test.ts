import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, enforcePolicy } from "../src/lib/policy/engine.ts";
import type { RenewalProposal } from "../src/types/renewal.ts";

const money = (value: string) => ({ currency_code: "USD", value });

const baseCtx = {
  outstanding: money("5.00"),
  currentPlanPrice: money("5.00"),
  ...DEFAULT_POLICY,
};

describe("enforcePolicy", () => {
  it("allows capture when outstanding > 0 and amount within bounds", () => {
    const proposal: RenewalProposal = {
      subscriptionId: "I-J8R13K0F76X4",
      action: "capture_outstanding",
      rationale: "Capture full outstanding after merchant approve",
      impact: money("5.00"),
    };
    assert.equal(enforcePolicy(proposal, baseCtx).ok, true);
  });

  it("rejects capture when outstanding is 0", () => {
    const proposal: RenewalProposal = {
      subscriptionId: "I-X",
      action: "capture_outstanding",
      rationale: "Should fail without outstanding balance present",
      impact: money("1.00"),
    };
    const r = enforcePolicy(proposal, { ...baseCtx, outstanding: money("0.00") });
    assert.equal(r.ok, false);
  });

  it("rejects capture below minCapturePct", () => {
    const proposal: RenewalProposal = {
      subscriptionId: "I-X",
      action: "capture_outstanding",
      rationale: "Partial capture too small versus policy floor",
      impact: money("1.00"),
    };
    const r = enforcePolicy(proposal, baseCtx);
    assert.equal(r.ok, false);
  });

  it("rejects write_off", () => {
    const proposal = {
      subscriptionId: "I-X",
      action: "write_off",
      rationale: "Attempt full forgive which policy must refuse",
    } as unknown as RenewalProposal;
    const r = enforcePolicy(proposal, baseCtx);
    assert.equal(r.ok, false);
  });

  it("rejects revise discount above max", () => {
    const proposal: RenewalProposal = {
      subscriptionId: "I-X",
      action: "revise_cheaper",
      rationale: "Too steep discount should be blocked by policy",
      proposedPrice: money("1.00"),
    };
    const r = enforcePolicy(proposal, baseCtx);
    assert.equal(r.ok, false);
  });

  it("allows revise within max discount", () => {
    const proposal: RenewalProposal = {
      subscriptionId: "I-X",
      action: "revise_cheaper",
      rationale: "Thirty percent retention revise within policy cap",
      proposedPrice: money("3.50"),
    };
    assert.equal(enforcePolicy(proposal, baseCtx).ok, true);
  });
});
