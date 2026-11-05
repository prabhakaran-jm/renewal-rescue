import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDITED_VERIFIED_RECOVERY_TXN_IDS,
  appendVerifiedRecovery,
  clearRecoveredSessionForTests,
  firstQualifyingCompletedTxn,
  firstVerifiedRecoveryTxn,
  isAuditedVerifiedRecoveryTxnId,
  isRecoveredTransaction,
  isVerifiedBalanceRecoveryTxn,
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
  it("counts COMPLETED $5 capture as qualifying", () => {
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

describe("audited allowlist + correlation attribution (P0 honesty)", () => {
  it("documents the known $16-board historical txn ids", () => {
    // Money-proof $5 + film $5; smoke $6 id not in repo fixtures.
    assert.equal(isAuditedVerifiedRecoveryTxnId("7RG29592AA729850V"), true);
    assert.equal(isAuditedVerifiedRecoveryTxnId("57J03146YN2648933"), true);
    assert.ok(AUDITED_VERIFIED_RECOVERY_TXN_IDS.has("7RG29592AA729850V"));
    assert.ok(AUDITED_VERIFIED_RECOVERY_TXN_IDS.has("57J03146YN2648933"));
    assert.equal(isAuditedVerifiedRecoveryTxnId("4D9358391Y4514409"), false);
  });

  it("generic first-$5 COMPLETED is NOT verified without allowlist/correlation", () => {
    const generic = txn({
      id: "RANDOM_FIRST_5",
      value: "5.00",
      time: "2026-10-31T12:00:00.000Z",
    });
    assert.equal(isRecoveredTransaction(generic), true);
    assert.equal(isVerifiedBalanceRecoveryTxn(generic), false);
    assert.equal(firstVerifiedRecoveryTxn([generic]), null);
    assert.equal(firstQualifyingCompletedTxn([generic])?.id, "RANDOM_FIRST_5");
  });

  it("audited historical txn is verified recovery", () => {
    const audited = txn({
      id: "7RG29592AA729850V",
      value: "5.00",
      time: "2026-10-31T12:46:47.000Z",
    });
    assert.equal(isVerifiedBalanceRecoveryTxn(audited), true);
    assert.equal(firstVerifiedRecoveryTxn([audited])?.id, "7RG29592AA729850V");
  });

  it("correlated capture txn id marks verified recovery", () => {
    const correlated = new Set(["DESK_CAPTURE_TXN_99"]);
    const t = txn({
      id: "DESK_CAPTURE_TXN_99",
      value: "6.00",
      time: "2026-11-05T12:00:00.000Z",
    });
    assert.equal(isVerifiedBalanceRecoveryTxn(t), false);
    assert.equal(isVerifiedBalanceRecoveryTxn(t, correlated), true);
    assert.equal(
      firstVerifiedRecoveryTxn([t], correlated)?.id,
      "DESK_CAPTURE_TXN_99"
    );
  });

  it("picks earliest verified among mixed qualifying + audited", () => {
    const first = firstVerifiedRecoveryTxn([
      txn({
        id: "SETUP",
        value: "1.00",
        time: "2026-10-30T10:00:00.000Z",
      }),
      txn({
        id: "GENERIC_LATER",
        value: "5.00",
        time: "2026-11-02T12:00:00.000Z",
      }),
      txn({
        id: "57J03146YN2648933",
        value: "5.00",
        time: "2026-10-31T12:00:00.000Z",
      }),
    ]);
    assert.equal(first?.id, "57J03146YN2648933");
  });

  it("completed_payment rows excluded from verified total", () => {
    const completedOnly: RecoveredMrrRow = {
      id: "paypal_GENERIC",
      subscriptionId: "I-AAA",
      recoveryAction: "capture_outstanding",
      amountRecovered: money("5.00"),
      deskStatus: "RECOVERED",
      transactionId: "GENERIC",
      transactionStatus: "COMPLETED",
      recoveredAt: "2026-10-31T12:00:00.000Z",
      outstandingCleared: true,
      source: "paypal_transactions",
      pending: false,
      attribution: "completed_payment",
    };
    const verified: RecoveredMrrRow = {
      id: "paypal_7RG29592AA729850V",
      subscriptionId: "I-J8R13K0F76X4",
      recoveryAction: "capture_outstanding",
      amountRecovered: money("5.00"),
      deskStatus: "RECOVERED",
      transactionId: "7RG29592AA729850V",
      transactionStatus: "COMPLETED",
      recoveredAt: "2026-10-31T12:46:47.000Z",
      outstandingCleared: true,
      source: "paypal_transactions",
      pending: false,
      attribution: "verified_recovery",
    };
    assert.equal(isVerifiedRecoveryRow(completedOnly), false);
    assert.equal(isVerifiedRecoveryRow(verified), true);
    assert.equal(sumRecoveredUsd([verified, completedOnly]), 5);
  });
});

describe("first qualifying vs verified", () => {
  it("firstQualifyingCompletedTxn picks earliest COMPLETED ≥ $5", () => {
    const first = firstQualifyingCompletedTxn([
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
      firstQualifyingCompletedTxn([
        txn({ id: "SETUP", value: "1.00", time: "2026-10-30T10:00:00.000Z" }),
      ]),
      null
    );
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
    attribution: "verified_recovery",
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
    attribution: "pending",
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
  it("appendVerifiedRecovery uses transactionStatus null (not COMPLETED)", () => {
    clearRecoveredSessionForTests();
    const row = appendVerifiedRecovery({
      subscriptionId: "I-3FSFGWWRAV4D",
      amount: money("6.00"),
      proposalId: "prop_pend_status",
      paypal: { status: "NO_CONTENT" },
    });
    // NO_CONTENT is a real status string from async capture — keep it.
    // When paypal has no status, pending must stay null (not invent COMPLETED).
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
    void row;
  });
});
