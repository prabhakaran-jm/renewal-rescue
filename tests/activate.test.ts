import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activateAfterCaptureAction,
  extractPaypalErrorName,
} from "../src/lib/recovery/activate.ts";
import type { PaypalSubscription } from "../src/lib/paypal/billing.ts";

function makeErr(
  status: number,
  name: string,
  message = "PayPal error"
): Error & { status: number; body: { name: string; message: string } } {
  const err = new Error(
    `PayPal POST /v1/billing/subscriptions/I-X/activate → HTTP ${status}: ${message}`
  ) as Error & { status: number; body: { name: string; message: string } };
  err.status = status;
  err.body = { name, message };
  return err;
}

describe("activateAfterCaptureAction GET-verify", () => {
  it("ok + restored when activate succeeds and GET is ACTIVE", async () => {
    const r = await activateAfterCaptureAction("I-OK", undefined, {
      activate: async () => ({ status: "ACTIVE", id: "I-OK" }),
      get: async () =>
        ({ id: "I-OK", status: "ACTIVE" }) as PaypalSubscription,
      log: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(r.restored, true);
    assert.equal(r.status, "ACTIVE");
    assert.equal(r.reactivationPending, undefined);
  });

  it("422 + GET ACTIVE → restored (never bare 422 alreadyActive)", async () => {
    const r = await activateAfterCaptureAction("I-ALREADY", undefined, {
      activate: async () => {
        throw makeErr(422, "SUBSCRIPTION_STATUS_INVALID", "already active");
      },
      get: async () =>
        ({ id: "I-ALREADY", status: "ACTIVE" }) as PaypalSubscription,
      log: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(r.restored, true);
    assert.equal(r.status, "ACTIVE");
    assert.equal(r.paypalErrorName, "SUBSCRIPTION_STATUS_INVALID");
    assert.equal(
      (r as { alreadyActive?: boolean }).alreadyActive,
      undefined
    );
  });

  it("422 + GET SUSPENDED → reactivation pending (not ok)", async () => {
    const r = await activateAfterCaptureAction("I-STUCK", undefined, {
      activate: async () => {
        throw makeErr(422, "UNPROCESSABLE_ENTITY", "cannot activate");
      },
      get: async () =>
        ({ id: "I-STUCK", status: "SUSPENDED" }) as PaypalSubscription,
      log: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.reactivationPending, true);
    assert.equal(r.status, "SUSPENDED");
    assert.equal(r.restored, undefined);
    assert.equal(r.paypalErrorName, "UNPROCESSABLE_ENTITY");
    assert.equal(
      (r as { alreadyActive?: boolean }).alreadyActive,
      undefined
    );
  });

  it("GET ACTIVE after successful activate body without trusting 422 alone", async () => {
    const r = await activateAfterCaptureAction("I-GET", undefined, {
      activate: async () => ({ status: "UNKNOWN" }),
      get: async () =>
        ({ id: "I-GET", status: "ACTIVE" }) as PaypalSubscription,
      log: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(r.restored, true);
  });
});

describe("extractPaypalErrorName", () => {
  it("returns body.name when present", () => {
    const err = makeErr(422, "SUBSCRIPTION_STATUS_INVALID", "cannot activate");
    assert.equal(extractPaypalErrorName(err), "SUBSCRIPTION_STATUS_INVALID");
  });

  it("returns undefined when no body.name (no message regex fallback)", () => {
    const err = new Error(
      "PayPal POST /v1/billing/subscriptions/I-X/activate → HTTP 422: UNPROCESSABLE_ENTITY"
    ) as Error & { status: number; body: { message: string } };
    err.status = 422;
    err.body = { message: "UNPROCESSABLE_ENTITY something" };
    assert.equal(extractPaypalErrorName(err), undefined);
  });
});
