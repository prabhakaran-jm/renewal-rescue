/**
 * Create 3–4 sandbox subscriptions for failure-path seeding.
 *
 * IMPORTANT: Buyer approval is interactive. This script creates APPROVAL_PENDING
 * subscriptions and prints approve links. Complete each in a sandbox personal
 * account, then re-run with --refresh to record ACTIVE status + ids.
 *
 * Failure-path labeling (manual buyer setup in sandbox):
 *  1. drained-balance  → buyer with empty / insufficient PayPal balance + card that declines
 *  2. card-removed     → approve then remove funding instrument in sandbox buyer wallet
 *  3. setup-fee-continue → use setupFee plan (setup_fee + CONTINUE + threshold 1)
 *  4. (optional) dual-fail → second drained buyer on standard plan
 *
 * Usage:
 *   npm run seed:subs
 *   node scripts/seed/seed-subscriptions.mjs --refresh
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paypalFetch, requireEnv } from "./lib/paypal.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../fixtures");
const IDS_PATH = resolve(FIXTURES, "seed-ids.json");

const BUYERS = [
  {
    key: "drained-balance",
    plan: "standard",
    note: "Sandbox buyer: drain balance / decline card before first renewal",
    given_name: "Drain",
    surname: "Balance",
    email: "buyer-drain@example.com",
  },
  {
    key: "card-removed",
    plan: "standard",
    note: "Sandbox buyer: approve, then remove card/funding instrument",
    given_name: "Card",
    surname: "Removed",
    email: "buyer-cardgone@example.com",
  },
  {
    key: "setup-fee-continue",
    plan: "setupFee",
    note: "setup_fee + CONTINUE + auto_bill_outstanding + payment_failure_threshold 1",
    given_name: "Setup",
    surname: "Continue",
    email: "buyer-setupfee@example.com",
  },
  {
    key: "drained-balance-2",
    plan: "standard",
    note: "Optional 4th path — second drained / decline buyer",
    given_name: "Drain",
    surname: "Two",
    email: "buyer-drain2@example.com",
  },
];

function loadIds() {
  if (!existsSync(IDS_PATH)) return {};
  return JSON.parse(readFileSync(IDS_PATH, "utf8"));
}

function saveIds(patch) {
  mkdirSync(FIXTURES, { recursive: true });
  const next = { ...loadIds(), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(IDS_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}

function approveLink(sub) {
  return sub.links?.find((l) => l.rel === "approve")?.href ?? null;
}

async function createSubscription(buyer, planId) {
  const returnBase =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "http://localhost:3000";

  return paypalFetch("/v1/billing/subscriptions", {
    method: "POST",
    prefer: "return=representation",
    body: {
      plan_id: planId,
      custom_id: `rr-seed-${buyer.key}`,
      start_time: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      subscriber: {
        name: { given_name: buyer.given_name, surname: buyer.surname },
        email_address: buyer.email,
      },
      application_context: {
        brand_name: "Renewal Rescue Seed",
        locale: "en-US",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: `${returnBase}/seed/return?buyer=${buyer.key}`,
        cancel_url: `${returnBase}/seed/cancel?buyer=${buyer.key}`,
      },
    },
  });
}

async function refreshSubscriptions(ids) {
  const subs = { ...(ids.subscriptions || {}) };
  for (const [key, row] of Object.entries(subs)) {
    if (!row?.id) continue;
    const live = await paypalFetch(`/v1/billing/subscriptions/${row.id}`);
    const outstanding = live.billing_info?.outstanding_balance ?? null;
    subs[key] = {
      ...row,
      status: live.status,
      outstanding_balance: outstanding,
      last_payment: live.billing_info?.last_payment ?? null,
      failed_payments_count: live.billing_info?.failed_payments_count ?? null,
      refreshedAt: new Date().toISOString(),
    };
    console.log(
      `${key}: ${live.id} status=${live.status} outstanding=${
        outstanding ? `${outstanding.value} ${outstanding.currency_code}` : "n/a"
      }`
    );
  }
  return saveIds({ subscriptions: subs });
}

async function main() {
  requireEnv(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
  const refresh = process.argv.includes("--refresh");
  let ids = loadIds();

  if (!ids.plans?.standard || !ids.plans?.setupFee) {
    throw new Error("Missing plan ids — run npm run seed:plans first");
  }

  if (refresh) {
    return refreshSubscriptions(ids);
  }

  const subscriptions = { ...(ids.subscriptions || {}) };

  for (const buyer of BUYERS) {
    if (subscriptions[buyer.key]?.id) {
      console.log(`Skip ${buyer.key} — already have ${subscriptions[buyer.key].id}`);
      continue;
    }
    const planId =
      buyer.plan === "setupFee" ? ids.plans.setupFee : ids.plans.standard;
    const sub = await createSubscription(buyer, planId);
    const link = approveLink(sub);
    subscriptions[buyer.key] = {
      id: sub.id,
      planId,
      planKey: buyer.plan,
      status: sub.status,
      failurePath: buyer.key,
      note: buyer.note,
      approveUrl: link,
      createdAt: new Date().toISOString(),
    };
    console.log(`Created ${buyer.key}: ${sub.id} status=${sub.status}`);
    if (link) console.log(`  Approve (sandbox personal account): ${link}`);
    console.log(`  Manual: ${buyer.note}`);
  }

  ids = saveIds({ subscriptions });
  console.log("\nNext:");
  console.log("  1. Open each approve URL in a distinct sandbox personal buyer");
  console.log("  2. Apply failure method (drain / remove card / leave setup-fee path)");
  console.log("  3. node scripts/seed/seed-subscriptions.mjs --refresh");
  console.log("  4. npm run check:daily  (through Nov 3)");
  return ids;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(err.code === "MISSING_ENV" ? 2 : 1);
});
