import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
    transactionStatus: "COMPLETED",
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
