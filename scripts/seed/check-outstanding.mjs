/**
 * Daily check through Nov 3 DECIDE.
 * Pulls each seeded subscription and reports outstanding_balance / status.
 *
 * Usage: npm run check:daily
 * Exit 0 always (informational). Prints DECIDE hint if any outstanding > 0.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paypalFetch, requireEnv } from "./lib/paypal.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../fixtures");
const IDS_PATH = resolve(FIXTURES, "seed-ids.json");
const LOG_DIR = resolve(__dirname, "../../fixtures/daily-checks");

function loadIds() {
  if (!existsSync(IDS_PATH)) {
    throw new Error("fixtures/seed-ids.json missing — run seed scripts first");
  }
  return JSON.parse(readFileSync(IDS_PATH, "utf8"));
}

async function main() {
  requireEnv(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
  const ids = loadIds();
  const subs = ids.subscriptions || {};
  const keys = Object.keys(subs);
  if (!keys.length) {
    throw new Error("No subscriptions recorded yet");
  }

  const checkedAt = new Date().toISOString();
  const rows = [];
  let anyOutstanding = false;

  console.log(`Daily check @ ${checkedAt}`);
  console.log("─".repeat(72));

  for (const key of keys) {
    const row = subs[key];
    if (!row?.id) continue;
    const live = await paypalFetch(`/v1/billing/subscriptions/${row.id}`);
    const outstanding = live.billing_info?.outstanding_balance;
    const value = outstanding ? Number(outstanding.value) : 0;
    if (value > 0) anyOutstanding = true;

    const summary = {
      key,
      id: live.id,
      status: live.status,
      outstanding: outstanding || null,
      failed_payments_count: live.billing_info?.failed_payments_count ?? null,
      next_billing_time: live.billing_info?.next_billing_time ?? null,
      last_payment: live.billing_info?.last_payment ?? null,
    };
    rows.push(summary);

    console.log(
      `${key.padEnd(22)} ${live.id}  status=${live.status}  outstanding=${
        outstanding ? `${outstanding.value} ${outstanding.currency_code}` : "0"
      }  failed=${summary.failed_payments_count ?? "n/a"}`
    );
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const day = checkedAt.slice(0, 10);
  const outPath = resolve(LOG_DIR, `${day}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ checkedAt, anyOutstanding, rows }, null, 2) + "\n"
  );

  console.log("─".repeat(72));
  if (anyOutstanding) {
    console.log(
      "DECIDE hint: at least one outstanding_balance > 0 → build Renewal Rescue (Nov 3 rule)."
    );
  } else {
    console.log(
      "No outstanding yet. Expected — PayPal retries ~every 5 days. Keep checking through Nov 3. Do NOT flip product on Oct 30."
    );
  }
  console.log("Wrote", outPath);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(err.code === "MISSING_ENV" ? 2 : 1);
});
