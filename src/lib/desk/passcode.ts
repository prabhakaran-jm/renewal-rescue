import { timingSafeEqual } from "node:crypto";

export type PasscodeCheck =
  | { ok: true }
  | { ok: false; reason: "missing_env" | "missing_passcode" | "mismatch" };

function toBuffer(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

/**
 * Constant-time compare of demo passcode.
 * Never log the expected or provided values.
 */
export function checkDemoPasscode(
  provided: string | null | undefined,
  expected: string | null | undefined = process.env.DEMO_PASSCODE
): PasscodeCheck {
  const want = typeof expected === "string" ? expected : "";
  if (!want) {
    return { ok: false, reason: "missing_env" };
  }
  if (provided == null || provided === "") {
    return { ok: false, reason: "missing_passcode" };
  }
  const a = toBuffer(provided);
  const b = toBuffer(want);
  // timingSafeEqual requires equal length — pad via hash-length normalize
  // by comparing HMAC-sized digests would need crypto; instead reject length
  // mismatch without leaking via early return that still uses equal-length buffers.
  if (a.length !== b.length) {
    // Compare against itself to keep a constant-time-ish path, then fail.
    timingSafeEqual(a, a);
    return { ok: false, reason: "mismatch" };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/** Read passcode from JSON body or x-demo-passcode header. */
export function extractPasscode(
  body: unknown,
  headerValue: string | null
): string | null {
  if (typeof headerValue === "string" && headerValue.length > 0) {
    return headerValue;
  }
  if (body && typeof body === "object" && "passcode" in body) {
    const p = (body as { passcode?: unknown }).passcode;
    if (typeof p === "string") return p;
  }
  return null;
}
