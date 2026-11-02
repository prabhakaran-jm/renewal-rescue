/**
 * One-shot live probe: GET subscription transactions.
 * Never prints secrets. Write redacted summary to stdout.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
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

loadEnv();

const apiBase =
  (process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com").replace(
    /\/$/,
    ""
  );
const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  console.error(
    JSON.stringify({
      ok: false,
      error: "PAYPAL_CLIENT_ID/SECRET missing",
      paypalCredsPresent: Boolean(clientId && clientSecret),
    })
  );
  process.exit(1);
}

const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
const tokenBody = await tokenRes.json();
if (!tokenRes.ok || !tokenBody.access_token) {
  console.error(
    JSON.stringify({
      ok: false,
      error: `oauth HTTP ${tokenRes.status}`,
      paypalCredsPresent: true,
    })
  );
  process.exit(1);
}

const start = "2024-01-01T00:00:00.000Z";
const end = new Date().toISOString();
const subId = "I-J8R13K0F76X4";
const url = `${apiBase}/v1/billing/subscriptions/${subId}/transactions?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${tokenBody.access_token}` },
});
const data = await res.json();
if (!res.ok) {
  console.error(
    JSON.stringify({
      ok: false,
      httpStatus: res.status,
      message: data?.message || data?.name || "error",
    })
  );
  process.exit(1);
}

const txns = Array.isArray(data.transactions) ? data.transactions : [];
const summary = {
  ok: true,
  subscriptionId: subId,
  transactionCount: txns.length,
  topLevelKeys: Object.keys(data),
  transactions: txns.map((t) => ({
    id: t.id ?? null,
    status: t.status ?? null,
    time: t.time ?? null,
    amount_with_breakdown: t.amount_with_breakdown
      ? {
          gross: t.amount_with_breakdown.gross_amount ?? null,
          fee: t.amount_with_breakdown.fee_amount ?? null,
          net: t.amount_with_breakdown.net_amount ?? null,
        }
      : null,
    payer_name: t.payer_name ? true : false,
    keys: Object.keys(t),
  })),
};
console.log(JSON.stringify(summary, null, 2));
