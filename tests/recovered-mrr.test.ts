import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRecoveredTransaction } from "../src/lib/desk/recovered-mrr.ts";

describe("recovered MRR txn rule (probe-informed)", () => {
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
});
