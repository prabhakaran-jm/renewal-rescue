import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_PROBE_RECOVERED_MRR_IDS,
  preferredCaptureId,
  recoveredMrrSubscriptionIds,
  resolveSeedSubscriptionEntries,
  sanitizePaypalSubscriptionId,
} from "../src/lib/desk/seed.ts";

describe("sanitizePaypalSubscriptionId", () => {
  it("accepts bare I- ids", () => {
    assert.equal(sanitizePaypalSubscriptionId("I-CNCX69GD2UD8"), "I-CNCX69GD2UD8");
  });

  it("strips accidental KEY= prefix", () => {
    assert.equal(
      sanitizePaypalSubscriptionId("SEED_SUBSCRIPTION_ID=I-CNCX69GD2UD8"),
      "I-CNCX69GD2UD8"
    );
  });

  it("rejects non I- values", () => {
    assert.equal(sanitizePaypalSubscriptionId("not-an-id"), null);
    assert.equal(sanitizePaypalSubscriptionId("SEED_SUBSCRIPTION_IDS"), null);
  });
});

describe("resolveSeedSubscriptionEntries (Vercel env-only)", () => {
  const prevIds = process.env.SEED_SUBSCRIPTION_IDS;
  const prevId = process.env.SEED_SUBSCRIPTION_ID;

  after(() => {
    if (prevIds === undefined) delete process.env.SEED_SUBSCRIPTION_IDS;
    else process.env.SEED_SUBSCRIPTION_IDS = prevIds;
    if (prevId === undefined) delete process.env.SEED_SUBSCRIPTION_ID;
    else process.env.SEED_SUBSCRIPTION_ID = prevId;
  });

  it("does not throw when fixture file is unused / env IDs set", () => {
    process.env.SEED_SUBSCRIPTION_IDS =
      "I-CNCX69GD2UD8,I-3FSFGWWRAV4D,I-J8R13K0F76X4";
    const entries = resolveSeedSubscriptionEntries();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].row.id, "I-CNCX69GD2UD8");
  });

  it("strips KEY= pasted into SEED_SUBSCRIPTION_IDS value", () => {
    process.env.SEED_SUBSCRIPTION_IDS =
      "SEED_SUBSCRIPTION_IDS=I-3FSFGWWRAV4D,I-CNCX69GD2UD8";
    const entries = resolveSeedSubscriptionEntries();
    assert.deepEqual(
      entries.map((e) => e.row.id),
      ["I-3FSFGWWRAV4D", "I-CNCX69GD2UD8"]
    );
  });

  it("preferredCaptureId strips KEY= paste", () => {
    process.env.SEED_SUBSCRIPTION_ID =
      "SEED_SUBSCRIPTION_ID=I-CNCX69GD2UD8";
    assert.equal(preferredCaptureId(), "I-CNCX69GD2UD8");
  });

  it("recoveredMrrSubscriptionIds always includes money-proof history ids", () => {
    // Trimmed env (judge spares only) — still probe history / film / smoke
    process.env.SEED_SUBSCRIPTION_IDS = "I-S5J71BPHJBT3,I-FWR8V1TKDEFW";
    const ids = recoveredMrrSubscriptionIds();
    for (const must of ALWAYS_PROBE_RECOVERED_MRR_IDS) {
      assert.ok(ids.includes(must), `missing always-probe id ${must}`);
    }
    assert.ok(ids.includes("I-S5J71BPHJBT3"));
    assert.ok(ids.includes("I-FWR8V1TKDEFW"));
  });
});
