import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkDemoPasscode,
  extractPasscode,
} from "../src/lib/desk/passcode.ts";

describe("checkDemoPasscode", () => {
  it("accepts exact match via timingSafeEqual", () => {
    const r = checkDemoPasscode("correct-horse", "correct-horse");
    assert.equal(r.ok, true);
  });

  it("rejects mismatch", () => {
    const r = checkDemoPasscode("wrong-pass", "correct-horse");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "mismatch");
  });

  it("rejects different lengths as mismatch", () => {
    const r = checkDemoPasscode("short", "much-longer-secret");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "mismatch");
  });

  it("rejects missing provided passcode", () => {
    const r = checkDemoPasscode(null, "set-in-env");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "missing_passcode");
  });

  it("rejects when DEMO_PASSCODE env unset", () => {
    const r = checkDemoPasscode("anything", "");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "missing_env");
  });
});

describe("extractPasscode", () => {
  it("prefers header over body", () => {
    assert.equal(
      extractPasscode({ passcode: "body" }, "header"),
      "header"
    );
  });

  it("falls back to body.passcode", () => {
    assert.equal(extractPasscode({ passcode: "from-body" }, null), "from-body");
  });
});
