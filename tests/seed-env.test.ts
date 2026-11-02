import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveSeedSubscriptionEntries } from "../src/lib/desk/seed.ts";

describe("resolveSeedSubscriptionEntries (Vercel env-only)", () => {
  const prev = process.env.SEED_SUBSCRIPTION_IDS;

  before(() => {
    process.env.SEED_SUBSCRIPTION_IDS =
      "I-CNCX69GD2UD8,I-3FSFGWWRAV4D,I-J8R13K0F76X4";
  });

  after(() => {
    if (prev === undefined) delete process.env.SEED_SUBSCRIPTION_IDS;
    else process.env.SEED_SUBSCRIPTION_IDS = prev;
  });

  it("does not throw when fixture file is unused / env IDs set", () => {
    const entries = resolveSeedSubscriptionEntries();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].row.id, "I-CNCX69GD2UD8");
    assert.ok(entries.some((e) => e.key === "outstanding-film" || e.row.id === "I-CNCX69GD2UD8"));
  });
});
