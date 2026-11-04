import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNoMoneyApproveAction,
  noMoneyApproveMessage,
  shouldShowCaptureNow,
} from "../src/lib/desk/approve-copy";

describe("approve-copy", () => {
  it("noMoneyApproveMessage — retry_later", () => {
    assert.equal(
      noMoneyApproveMessage("retry_later"),
      "Approved: no money moved — retry scheduled by merchant"
    );
  });

  it("noMoneyApproveMessage — escalate", () => {
    assert.equal(
      noMoneyApproveMessage("escalate"),
      "Approved: no money moved — escalated by merchant"
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
});
