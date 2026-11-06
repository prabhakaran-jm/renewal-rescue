import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendVerifiedRecovery,
  clearRecoveredSessionForTests,
  firstVerifiedRecoveryTxn,
  isRecoveredTransaction,
  isVerifiedRecoveryRow,
  sumRecoveredUsd,
  type RecoveredMrrRow,
} from "../src/lib/desk/recovered-mrr.ts";
import type { PaypalSubscriptionTransaction } from "../src/lib/paypal/billing.ts";

const money = (value: string) => ({ currency_code: "USD", value });

function txn(
  partial: Partial<PaypalSubscriptionTransaction> & {
    id: string;
    status?: string;
    value?: string;
    time?: string;
  }
): PaypalSubscriptionTransaction {
  return {
    id: partial.id,
    status: partial.status ?? "COMPLETED",
    time: partial.time ?? "2026-10-31T12:00:00.000Z",
    amount_with_breakdown: {
      gross_amount: money(partial.value ?? "5.00"),
    },
  };
}

describe("recovered txn rule (probe-informed)", () => {
  it("counts COMPLETED $5 capture", () => {
    assert.equal(
      isRecoveredTransaction({
        id: "7RG29592AA729850V",
        status: "COMPLETED",
        time: "2026-10-31T12:46:47.000Z",
        amount_with_breakdown: {
          gross_amount: { currency_code: "USD", value: "5.00" },
        },
      }),
      true
    );
  });

  it("counts live smoke $6 txn 8W0050137N871594H", () => {
    assert.equal(
      isRecoveredTransaction({
        id: "8W0050137N871594H",
        status: "COMPLETED",
        time: "2026-11-04T00:00:00.000Z",
        amount_with_breakdown: {
          gross_amount: { currency_code: "USD", value: "6.00" },
        },
      }),
      true
    );
  });

  it("excludes COMPLETED $1 setup fee", () => {
    assert.equal(
      isRecoveredTransaction({
        id: "8F510825CX301480C",
        status: "COMPLETED",
        time: "2026-10-31T10:21:17.000Z",
        amount_with_breakdown: {
          gross_amount: { currency_code: "USD", value: "1.00" },
        },
      }),
      false
    );
  });

  it("excludes non-COMPLETED", () => {
    assert.equal(
      isRecoveredTransaction({
        id: "X",
        status: "PENDING",
        amount_with_breakdown: {
          gross_amount: { currency_code: "USD", value: "5.00" },
        },
      }),
      false
    );
  });

  it("excludes COMPLETED below $5 (txn ≥ $5 filter unchanged)", () => {
    assert.equal(
      isRecoveredTransaction({
        id: "UNDER",
        status: "COMPLETED",
        amount_with_breakdown: {
          gross_amount: { currency_code: "USD", value: "4.99" },
        },
      }),
      false
    );
  });
});

describe("first-$5 verified recovery attribution", () => {
  it("picks the earliest COMPLETED ≥ $5 (undercounts later doubles)", () => {
    const first = firstVerifiedRecoveryTxn([
      txn({
        id: "SETUP",
        value: "1.00",
        time: "2026-10-30T10:00:00.000Z",
      }),
      txn({
        id: "SECOND",
        value: "5.00",
        time: "2026-11-02T12:00:00.000Z",
      }),
      txn({
        id: "FIRST",
        value: "6.00",
        time: "2026-10-31T12:00:00.000Z",
      }),
    ]);
    assert.equal(first?.id, "FIRST");
  });

  it("returns null when only setup-fee COMPLETED exists", () => {
    assert.equal(
      firstVerifiedRecoveryTxn([
        txn({ id: "SETUP", value: "1.00", time: "2026-10-30T10:00:00.000Z" }),
      ]),
      null
    );
  });
});

describe("NO_CONTENT capture + empty session still verifies from live list", () => {
  it("first-$5 on PayPal list is verified with no memory / null capture txn id", () => {
    // Simulate: Approve got async NO_CONTENT (no txn id recorded), then a
    // different Vercel instance with empty session memory runs Refresh.
    clearRecoveredSessionForTests();
    const pending = appendVerifiedRecovery({
      subscriptionId: "I-3FSFGWWRAV4D",
      amount: money("6.00"),
      proposalId: "prop_nocontent",
      paypal: { status: "NO_CONTENT", httpStatus: 202 },
    });
    assert.equal(pending.transactionId, null);
    assert.equal(pending.pending, true);
    assert.equal(pending.transactionStatus, "NO_CONTENT");

    // Cold start: wipe session — no in-memory correlation left.
    clearRecoveredSessionForTests();

    const smokeTxn = txn({
      id: "8W0050137N871594H",
      value: "6.00",
      time: "2026-11-04T12:00:00.000Z",
    });
    // Pure first-$5 rule — no allowlist, no correlated set.
    const fromList = firstVerifiedRecoveryTxn([
      txn({ id: "SETUP", value: "1.00", time: "2026-11-03T10:00:00.000Z" }),
      smokeTxn,
    ]);
    assert.equal(fromList?.id, "8W0050137N871594H");

    const row: RecoveredMrrRow = {
      id: "paypal_8W0050137N871594H",
      subscriptionId: "I-3FSFGWWRAV4D",
      recoveryAction: "capture_outstanding",
      amountRecovered: money("6.00"),
      deskStatus: "RECOVERED",
      transactionId: "8W0050137N871594H",
      transactionStatus: "COMPLETED",
      recoveredAt: "2026-11-04T12:00:00.000Z",
      outstandingCleared: true,
      source: "paypal_transactions",
      pending: false,
    };
    assert.equal(isVerifiedRecoveryRow(row), true);
    assert.equal(sumRecoveredUsd([row]), 6);
  });
});

describe("verified total excludes Recovery pending", () => {
  const verified: RecoveredMrrRow = {
    id: "paypal_FIRST",
    subscriptionId: "I-AAA",
    recoveryAction: "capture_outstanding",
    amountRecovered: money("5.00"),
    deskStatus: "RECOVERED",
    transactionId: "FIRST",
    transactionStatus: "COMPLETED",
    recoveredAt: "2026-10-31T12:00:00.000Z",
    outstandingCleared: true,
    source: "paypal_transactions",
    pending: false,
  };

  const pending: RecoveredMrrRow = {
    id: "desk_1",
    subscriptionId: "I-BBB",
    recoveryAction: "capture_outstanding",
    amountRecovered: money("6.00"),
    deskStatus: "RECOVERED",
    transactionId: null,
    transactionStatus: null,
    recoveredAt: "2026-11-05T12:00:00.000Z",
    outstandingCleared: true,
    source: "desk_approve",
    pending: true,
  };

  it("isVerifiedRecoveryRow rejects desk_approve / pending", () => {
    assert.equal(isVerifiedRecoveryRow(verified), true);
    assert.equal(isVerifiedRecoveryRow(pending), false);
    assert.equal(
      isVerifiedRecoveryRow({ source: "desk_approve", pending: false }),
      false
    );
  });

  it("sumRecoveredUsd excludes pending from verified total", () => {
    assert.equal(sumRecoveredUsd([verified, pending]), 5);
    assert.equal(sumRecoveredUsd([pending]), 0);
  });
});

describe("pending optimistic txn status", () => {
  it("appendVerifiedRecovery uses transactionStatus null when paypal has no status", () => {
    clearRecoveredSessionForTests();
    const noStatus = appendVerifiedRecovery({
      subscriptionId: "I-3FSFGWWRAV4D",
      amount: money("6.00"),
      proposalId: "prop_pend_null",
      paypal: {},
    });
    assert.equal(noStatus.pending, true);
    assert.equal(noStatus.transactionStatus, null);
    assert.notEqual(noStatus.transactionStatus, "COMPLETED");
    clearRecoveredSessionForTests();
  });
});
