import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  captureNowHint,
  isNoMoneyApproveAction,
  noMoneyApproveMessage,
  shouldShowCaptureNow,
} from "../src/lib/desk/approve-copy";

describe("approve-copy", () => {
  it("noMoneyApproveMessage — retry_later (no false schedule claim)", () => {
    assert.equal(
      noMoneyApproveMessage("retry_later"),
      "Approved: no money moved — marked retry later (no PayPal call)"
    );
  });

  it("noMoneyApproveMessage — escalate (no false schedule claim)", () => {
    assert.equal(
      noMoneyApproveMessage("escalate"),
      "Approved: no money moved — flagged for escalation (no PayPal call)"
    );
  });

  it("isNoMoneyApproveAction gates retry_later / escalate only", () => {
    assert.equal(isNoMoneyApproveAction("retry_later"), true);
    assert.equal(isNoMoneyApproveAction("escalate"), true);
    assert.equal(isNoMoneyApproveAction("capture_outstanding"), false);
    assert.equal(isNoMoneyApproveAction("revise_cheaper"), false);
    assert.equal(isNoMoneyApproveAction("write_off"), false);
  });

  it("shouldShowCaptureNow when outstanding > 0 and action ≠ capture", () => {
    assert.equal(
      shouldShowCaptureNow({
        outstandingValue: 5,
        proposalAction: "retry_later",
      }),
      true
    );
    assert.equal(
      shouldShowCaptureNow({
        outstandingValue: 5,
        proposalAction: "escalate",
      }),
      true
    );
    assert.equal(
      shouldShowCaptureNow({
        outstandingValue: 5,
        proposalAction: "revise_cheaper",
      }),
      true
    );
  });

  it("shouldShowCaptureNow hidden for capture_outstanding or $0", () => {
    assert.equal(
      shouldShowCaptureNow({
        outstandingValue: 5,
        proposalAction: "capture_outstanding",
      }),
      false
    );
    assert.equal(
      shouldShowCaptureNow({
        outstandingValue: 0,
        proposalAction: "retry_later",
      }),
      false
    );
    assert.equal(
      shouldShowCaptureNow({
        outstandingValue: 5,
        proposalAction: null,
      }),
      false
    );
  });

  it("captureNowHint — Gemini retry_later / escalate / revise_cheaper", () => {
    assert.equal(
      captureNowHint({
        action: "retry_later",
        aiSource: "gemini",
        outstandingValue: 6,
        currencyCode: "USD",
      }),
      "Gemini recommends retry_later. Merchant can override and capture the 6.00 USD outstanding now."
    );
    assert.equal(
      captureNowHint({
        action: "escalate",
        aiSource: "gemini",
        outstandingValue: 5,
        currencyCode: "USD",
      }),
      "Gemini recommends escalate. Merchant can override and capture the 5.00 USD outstanding now."
    );
    assert.equal(
      captureNowHint({
        action: "revise_cheaper",
        aiSource: "gemini",
        outstandingValue: 5,
        currencyCode: "USD",
      }),
      "Gemini recommends revise_cheaper. Merchant can override and capture the 5.00 USD outstanding now."
    );
  });

  it("captureNowHint — RULE (Revise / Deny paths) and fallback", () => {
    assert.equal(
      captureNowHint({
        action: "revise_cheaper",
        aiSource: "rule",
        outstandingValue: 5,
        currencyCode: "USD",
      }),
      "RULE recommends revise_cheaper. Merchant can override and capture the 5.00 USD outstanding now."
    );
    assert.equal(
      captureNowHint({
        action: "escalate",
        aiSource: "rule",
        outstandingValue: 5,
        currencyCode: "USD",
      }),
      "RULE recommends escalate. Merchant can override and capture the 5.00 USD outstanding now."
    );
    assert.equal(
      captureNowHint({
        action: "retry_later",
        aiSource: "fallback",
        outstandingValue: 5.5,
        currencyCode: "USD",
      }),
      "Fallback recommends retry_later. Merchant can override and capture the 5.50 USD outstanding now."
    );
    assert.equal(
      captureNowHint({
        action: "revise_cheaper",
        aiSource: "fallback",
        outstandingValue: 5,
      }),
      "Fallback recommends revise_cheaper. Merchant can override and capture the 5.00 USD outstanding now."
    );
  });
});
