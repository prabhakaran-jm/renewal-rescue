import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deskCardBadge,
  formatDeskAmount,
} from "../src/lib/desk/card-labels.ts";

describe("deskCardBadge", () => {
  it("Fixture only when no recovery txn and outstanding is $0", () => {
    const b = deskCardBadge({
      outstandingValue: 0,
      status: "SUSPENDED",
      hasVerifiedRecovery: false,
    });
    assert.equal(b.kind, "fixture");
    assert.equal(b.fixtureLabeled, true);
    assert.equal(b.label, "Fixture");
  });

  it("does NOT fixture-label $0 outstanding when first ≥ $5 COMPLETED exists", () => {
    const b = deskCardBadge({
      outstandingValue: 0,
      status: "SUSPENDED",
      hasVerifiedRecovery: true,
    });
    assert.equal(b.fixtureLabeled, false);
    assert.equal(b.kind, "balance_recovered_pending");
    assert.equal(b.label, "Balance recovered, reactivation pending");
  });

  it("Subscription restored when ACTIVE after verified recovery", () => {
    const b = deskCardBadge({
      outstandingValue: 0,
      status: "ACTIVE",
      hasVerifiedRecovery: true,
    });
    assert.equal(b.fixtureLabeled, false);
    assert.equal(b.kind, "subscription_restored");
    assert.equal(b.label, "Subscription restored");
  });

  it("Outstanding when balance remains", () => {
    const b = deskCardBadge({
      outstandingValue: 6,
      status: "SUSPENDED",
      hasVerifiedRecovery: false,
    });
    assert.equal(b.kind, "outstanding");
    assert.equal(b.fixtureLabeled, false);
  });

  it("outstanding 5 + hasVerifiedRecovery → Outstanding (not Balance recovered)", () => {
    const b = deskCardBadge({
      outstandingValue: 5,
      status: "SUSPENDED",
      hasVerifiedRecovery: true,
    });
    assert.equal(b.kind, "outstanding");
    assert.equal(b.label, "Outstanding");
    assert.equal(b.fixtureLabeled, false);
    assert.notEqual(b.label, "Balance recovered, reactivation pending");
  });
});

describe("formatDeskAmount", () => {
  it("always toFixed(2)", () => {
    assert.equal(formatDeskAmount(6, "USD"), "6.00 USD");
    assert.equal(formatDeskAmount("5.5", "USD"), "5.50 USD");
    assert.equal(formatDeskAmount(0), "0.00 USD");
  });
});
