import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coerceRecoveredBoardRow,
  mergeRecoveredBoard,
  recoveredRowDedupeKey,
  recoveryBoardSourceLabel,
  serverHasRecovery,
  sumRecoveredBoardUsd,
  upsertOptimisticRecovered,
  type RecoveredBoardRow,
} from "../src/lib/desk/merge-recovered.ts";

function row(
  partial: Partial<RecoveredBoardRow> &
    Pick<RecoveredBoardRow, "id" | "subscriptionId">
): RecoveredBoardRow {
  return {
    pathKey: partial.pathKey,
    amountRecovered: partial.amountRecovered || {
      currency_code: "USD",
      value: "5.00",
    },
    transactionId:
      partial.transactionId === undefined ? null : partial.transactionId,
    transactionStatus:
      partial.transactionStatus === undefined
        ? partial.pending || partial.source === "desk_approve"
          ? null
          : "COMPLETED"
        : partial.transactionStatus,
    recoveredAt: partial.recoveredAt || "2026-11-03T12:00:00.000Z",
    source: partial.source || "desk_approve",
    pending: partial.pending,
    proposalId: partial.proposalId,
    note: partial.note,
    id: partial.id,
    subscriptionId: partial.subscriptionId,
  };
}

describe("mergeRecoveredBoard (optimistic desk overlay)", () => {
  it("shows Recovery pending Approve row before PayPal board updates", () => {
    const optimistic = row({
      id: "desk_approve_1",
      subscriptionId: "I-3FSFGWWRAV4D",
      proposalId: "prop_abc",
      transactionId: "TXNWAIT01",
      source: "desk_approve",
      pending: true,
      amountRecovered: { currency_code: "USD", value: "5.00" },
    });

    const merged = mergeRecoveredBoard([], [optimistic]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "desk_approve_1");
    // Pending excluded from verified total
    assert.equal(sumRecoveredBoardUsd(merged), 0);
    assert.equal(recoveryBoardSourceLabel(merged[0]), "Recovery pending");
  });

  it("keeps optimistic row when server returns empty (lambda lag)", () => {
    const existing = [
      row({
        id: "paypal_OLD",
        subscriptionId: "I-J8R13K0F76X4",
        transactionId: "7RG29592AA729850V",
        source: "paypal_transactions",
        recoveredAt: "2026-10-31T12:46:47.000Z",
      }),
    ];
    const optimistic = [
      row({
        id: "desk_new",
        subscriptionId: "I-3FSFGWWRAV4D",
        proposalId: "prop_new",
        transactionId: "NEWTXN99",
        source: "desk_approve",
        pending: true,
        recoveredAt: "2026-11-03T15:00:00.000Z",
      }),
    ];
    // First paint with approve row present — verified total stays at paypal only
    let board = mergeRecoveredBoard(existing, optimistic);
    assert.equal(board.length, 2);
    assert.equal(sumRecoveredBoardUsd(board), 5);

    // Lag: GET returns empty / missing the new txn — do not wipe optimistic
    board = mergeRecoveredBoard([], optimistic);
    assert.equal(board.length, 1);
    assert.equal(board[0].id, "desk_new");
    assert.equal(sumRecoveredBoardUsd(board), 0);
  });

  it("dedupes when PayPal later returns the same txn id", () => {
    const optimistic = row({
      id: "desk_approve_1",
      subscriptionId: "I-3FSFGWWRAV4D",
      proposalId: "prop_abc",
      transactionId: "TXNWAIT01",
      source: "desk_approve",
      pending: true,
    });
    const server = row({
      id: "paypal_TXNWAIT01",
      subscriptionId: "I-3FSFGWWRAV4D",
      transactionId: "TXNWAIT01",
      source: "paypal_transactions",
      recoveredAt: "2026-11-03T15:01:00.000Z",
    });
    const merged = mergeRecoveredBoard([server], [optimistic]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "paypal_transactions");
    assert.equal(merged[0].id, "paypal_TXNWAIT01");
    assert.equal(sumRecoveredBoardUsd(merged), 5);
  });

  it("dedupes by proposalId when txn id still null on Approve", () => {
    const optimistic = row({
      id: "desk_1",
      subscriptionId: "I-CNCX69GD2UD8",
      proposalId: "prop_xyz",
      transactionId: null,
      source: "desk_approve",
      pending: true,
    });
    const server = row({
      id: "desk_1",
      subscriptionId: "I-CNCX69GD2UD8",
      proposalId: "prop_xyz",
      transactionId: "LATER123",
      source: "desk_approve",
      pending: true,
    });
    const merged = mergeRecoveredBoard([server], [optimistic]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].transactionId, "LATER123");
  });

  it("upsertOptimisticRecovered does not duplicate", () => {
    const a = row({
      id: "desk_1",
      subscriptionId: "I-3FSFGWWRAV4D",
      proposalId: "p1",
      transactionId: "T1",
    });
    const once = upsertOptimisticRecovered([], a);
    const twice = upsertOptimisticRecovered(once, { ...a, note: "again" });
    assert.equal(twice.length, 1);
  });

  it("coerceRecoveredBoardRow accepts Approve recovered payload as pending", () => {
    const coerced = coerceRecoveredBoardRow({
      id: "desk_x",
      subscriptionId: "I-3FSFGWWRAV4D",
      amountRecovered: { currency_code: "USD", value: "5.00" },
      transactionId: "ABC",
      transactionStatus: "COMPLETED",
      recoveredAt: "2026-11-03T12:00:00.000Z",
      source: "desk_approve",
      proposalId: "prop",
    });
    assert.ok(coerced);
    assert.equal(recoveredRowDedupeKey(coerced!), "txn:ABC");
    assert.equal(coerced!.pending, true);
    assert.equal(
      serverHasRecovery([coerced!], { transactionId: "ABC" }),
      true
    );
    assert.equal(sumRecoveredBoardUsd([coerced!]), 0);
  });

  it("coerceRecoveredBoardRow rejects junk", () => {
    assert.equal(coerceRecoveredBoardRow(null), null);
    assert.equal(coerceRecoveredBoardRow({ id: "x" }), null);
  });

  it("drops optimistic row when verified server row exists for same subscriptionId", () => {
    const optimistic = row({
      id: "desk_approve_1",
      subscriptionId: "I-3FSFGWWRAV4D",
      proposalId: "prop_abc",
      transactionId: "PENDINGTXN",
      source: "desk_approve",
      pending: true,
      recoveredAt: "2026-11-05T15:00:00.000Z",
    });
    const server = row({
      id: "paypal_8W0050137N871594H",
      subscriptionId: "I-3FSFGWWRAV4D",
      transactionId: "8W0050137N871594H",
      source: "paypal_transactions",
      pending: false,
      recoveredAt: "2026-11-05T15:01:00.000Z",
      amountRecovered: { currency_code: "USD", value: "6.00" },
    });
    const merged = mergeRecoveredBoard([server], [optimistic]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "paypal_8W0050137N871594H");
    assert.equal(merged[0].source, "paypal_transactions");
    assert.equal(sumRecoveredBoardUsd(merged), 6);
    assert.equal(recoveryBoardSourceLabel(merged[0]), "Verified");
  });
});
