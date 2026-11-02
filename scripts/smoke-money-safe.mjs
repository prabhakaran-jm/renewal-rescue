/**
 * Money-safe smoke: Propose → Approve with WRONG passcode → expect 401.
 * Never captures. Never prints secrets.
 *
 * Usage:
 *   node scripts/smoke-money-safe.mjs
 *   BASE_URL=https://your-app.vercel.app node scripts/smoke-money-safe.mjs
 *
 * Optional: SUBSCRIPTION_ID (defaults to SEED_SUBSCRIPTION_ID or film shell)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvQuietly() {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvQuietly();

const base = (
  process.env.BASE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const subscriptionId =
  process.env.SUBSCRIPTION_ID?.trim() ||
  process.env.SEED_SUBSCRIPTION_ID?.trim() ||
  "I-CNCX69GD2UD8";

const wrongPass = `wrong-${Date.now()}`;

console.log(
  JSON.stringify({
    step: "money-safe-smoke",
    baseUrl: base,
    subscriptionId,
    wrongPasscodeProvided: true,
    // never print real DEMO_PASSCODE
    demoPasscodeConfigured: Boolean(process.env.DEMO_PASSCODE?.trim()),
  })
);

const proposeRes = await fetch(`${base}/api/proposals`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ subscriptionId }),
});
const proposeBody = await proposeRes.json().catch(() => ({}));
if (!proposeRes.ok) {
  console.error(
    JSON.stringify({
      ok: false,
      phase: "propose",
      status: proposeRes.status,
      error: proposeBody.error || proposeBody,
    })
  );
  process.exit(1);
}

const proposalId = proposeBody.proposalId;
if (!proposalId) {
  console.error(JSON.stringify({ ok: false, phase: "propose", error: "missing proposalId" }));
  process.exit(1);
}

const approveRes = await fetch(
  `${base}/api/proposals/${encodeURIComponent(proposalId)}/approve`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-demo-passcode": wrongPass,
    },
    body: JSON.stringify({ passcode: wrongPass }),
  }
);
const approveBody = await approveRes.json().catch(() => ({}));

const ok = approveRes.status === 401;
console.log(
  JSON.stringify({
    ok,
    phase: "approve_wrong_passcode",
    status: approveRes.status,
    expect: 401,
    reason: approveBody.reason || null,
    error: approveBody.error || null,
    moneyMoved: false,
    note: ok
      ? "PASS — wrong passcode rejected; no capture"
      : "FAIL — expected HTTP 401",
  })
);
process.exit(ok ? 0 : 1);
