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
 *  5. judge-demo-outstanding → setupFee re-seed for desk Recover demo
 *     (drain → approve so setup fee fails → SUSPENDED+outstanding → restore funding; do NOT capture)
 *
 * Usage:
 *   npm run seed:subs
 *   node scripts/seed/seed-subscriptions.mjs --refresh
 *   node scripts/seed/seed-subscriptions.mjs --demo-outstanding
 *   node scripts/seed/seed-subscriptions.mjs --demo-outstanding --force
 *     (--force replaces a stale/404 APPROVAL_PENDING shell; approve within ~3h)
 *   node scripts/seed/seed-subscriptions.mjs --outstanding-batch
 *   node scripts/seed/seed-subscriptions.mjs --outstanding-batch --force
 *     (create four setupFee shells for Step 3; interactive drain→approve each)
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

/** Fresh setupFee shell for judge Recover demo (keeps setup-fee-continue as money-proof history). */
const DEMO_OUTSTANDING = {
  key: "judge-demo-outstanding",
  plan: "setupFee",
  note:
    "Judge demo re-seed: drain funding → approve (setup fee fails) → SUSPENDED+outstanding → restore funding; do NOT capture until demo",
  given_name: "Judge",
  surname: "Demo",
  email: "buyer-judge-demo@example.com",
};

/**
 * Step 3: four setupFee outstanding shells.
 * Roles: vercel-smoke may spend 1, film 1, leave ≥2 for judges.
 */
const OUTSTANDING_BATCH = [
  {
    key: "outstanding-smoke",
    plan: "setupFee",
    note: "Step3 shell A — Vercel money-safe smoke spare (prefer wrong-passcode before live capture)",
    given_name: "Smoke",
    surname: "Outstanding",
    email: "buyer-outstanding-smoke@example.com",
  },
  {
    key: "outstanding-film",
    plan: "setupFee",
    note: "Step3 shell B — film Deny→Propose→Approve capture",
    given_name: "Film",
    surname: "Outstanding",
    email: "buyer-outstanding-film@example.com",
  },
  {
    key: "outstanding-judge-1",
    plan: "setupFee",
    note: "Step3 shell C — leave for judges (do not capture in smoke/film)",
    given_name: "Judge",
    surname: "One",
    email: "buyer-outstanding-j1@example.com",
  },
  {
    key: "outstanding-judge-2",
    plan: "setupFee",
    note: "Step3 shell D — leave for judges (do not capture in smoke/film)",
    given_name: "Judge",
    surname: "Two",
    email: "buyer-outstanding-j2@example.com",
  },
];

function printSeedSubscriptionIdsHint(subscriptions) {
  const batchIds = OUTSTANDING_BATCH.map((b) => subscriptions[b.key]?.id).filter(
    Boolean
  );
  const moneyProof = subscriptions["setup-fee-continue"]?.id || "I-J8R13K0F76X4";
  const preferred =
    batchIds[1] ||
    batchIds[0] ||
    subscriptions["judge-demo-outstanding"]?.id ||
    "";
  const all = [...batchIds];
  if (!all.includes(moneyProof)) all.push(moneyProof);
  console.log("\nEnv hints (never commit real secrets):");
  console.log(`  SEED_SUBSCRIPTION_IDS=${all.join(",")}`);
  if (preferred) console.log(`  SEED_SUBSCRIPTION_ID=${preferred}`);
}

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
    let live;
    try {
      live = await paypalFetch(`/v1/billing/subscriptions/${row.id}`);
    } catch (err) {
      if (err.status === 404) {
        subs[key] = {
          ...row,
          status: "NOT_FOUND",
          refreshedAt: new Date().toISOString(),
          note: `${row.note || ""} [404 — APPROVAL_PENDING likely expired; re-run --demo-outstanding --force if this is judge-demo]`.trim(),
        };
        console.log(
          `${key}: ${row.id} status=NOT_FOUND (HTTP 404 — shell expired / gone)`
        );
        continue;
      }
      throw err;
    }
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

async function createBuyerShell(buyer, ids, subscriptions) {
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
  return { sub, link };
}

async function main() {
  requireEnv(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
  const refresh = process.argv.includes("--refresh");
  const demoOutstanding = process.argv.includes("--demo-outstanding");
  const outstandingBatch = process.argv.includes("--outstanding-batch");
  const force = process.argv.includes("--force");
  let ids = loadIds();

  if (!ids.plans?.standard || !ids.plans?.setupFee) {
    throw new Error("Missing plan ids — run npm run seed:plans first");
  }

  if (refresh) {
    return refreshSubscriptions(ids);
  }

  const subscriptions = { ...(ids.subscriptions || {}) };

  if (outstandingBatch) {
    for (const buyer of OUTSTANDING_BATCH) {
      const existing = subscriptions[buyer.key];
      if (existing?.id && !force) {
        console.log(
          `Skip ${buyer.key} — already have ${existing.id} (status=${existing.status || "?"})`
        );
        console.log(`  Approve URL: ${existing.approveUrl || "(none)"}`);
        continue;
      }
      if (existing?.id && force) {
        console.log(
          `Force-replace ${buyer.key}: superseding ${existing.id} (was ${existing.status || "?"})`
        );
        subscriptions[`${buyer.key}-superseded`] = {
          ...existing,
          supersededAt: new Date().toISOString(),
          note: `${existing.note || ""} [superseded]`.trim(),
        };
        delete subscriptions[buyer.key];
      }
      await createBuyerShell(buyer, ids, subscriptions);
    }
    const preferredKey = "outstanding-film";
    ids = saveIds({
      subscriptions,
      preferredCaptureKey: preferredKey,
      preferredCaptureId: subscriptions[preferredKey]?.id,
      outstandingBatchKeys: OUTSTANDING_BATCH.map((b) => b.key),
    });
    printSeedSubscriptionIdsHint(subscriptions);
    console.log("\nNext (interactive — each shell expires ~3h if unapproved):");
    console.log("  For EACH of the four approve URLs above:");
    console.log("    1. Drain sandbox personal buyer (balance ~0; remove good card)");
    console.log("    2. Open approve URL → Agree & Subscribe");
    console.log("    3. Expect setup fee fail → SUSPENDED + outstanding > 0");
    console.log("    4. Restore funding WITHOUT capturing");
    console.log("  Then: node scripts/seed/seed-subscriptions.mjs --refresh");
    console.log("        npm run check:daily");
    console.log("  Paste SEED_SUBSCRIPTION_IDS into .env / Vercel (see hint above).");
    console.log("  Budget: smoke≤1, film≤1, leave ≥2 for judges.");
    return ids;
  }

  if (demoOutstanding) {
    const existing = subscriptions[DEMO_OUTSTANDING.key];
    if (existing?.id && !force) {
      console.log(
        `Skip ${DEMO_OUTSTANDING.key} — already have ${existing.id} (status=${existing.status || "?"})`
      );
      console.log(`  Approve URL: ${existing.approveUrl || "(none)"}`);
      console.log(
        `  Money-proof history kept at setup-fee-continue → ${
          subscriptions["setup-fee-continue"]?.id || "n/a"
        }`
      );
      console.log(
        "\nIf GET returns 404 / APPROVAL_PENDING expired, re-run with --force:"
      );
      console.log(
        "  node scripts/seed/seed-subscriptions.mjs --demo-outstanding --force"
      );
      return ids;
    }
    if (existing?.id && force) {
      console.log(
        `Force-replace ${DEMO_OUTSTANDING.key}: superseding ${existing.id} (was ${existing.status || "?"})`
      );
      subscriptions[`${DEMO_OUTSTANDING.key}-superseded`] = {
        ...existing,
        supersededAt: new Date().toISOString(),
        note: `${existing.note || ""} [superseded — APPROVAL_PENDING expired / 404]`.trim(),
      };
      delete subscriptions[DEMO_OUTSTANDING.key];
    }
    await createBuyerShell(DEMO_OUTSTANDING, ids, subscriptions);
    ids = saveIds({
      subscriptions,
      preferredCaptureKey: DEMO_OUTSTANDING.key,
      preferredCaptureId: subscriptions[DEMO_OUTSTANDING.key].id,
    });
    console.log("\nNext (buyer — YOU must act SOON; shell expires in ~3h if unapproved):");
    console.log(
      "  1. Drain sandbox personal buyer funding (balance ~0; remove/unlink good card)"
    );
    console.log("  2. Open the approve URL above → Agree & Subscribe");
    console.log(
      "  3. Expect setup fee to fail → CONTINUE → SUSPENDED + outstanding_balance > 0"
    );
    console.log(
      "  4. Restore buyer funding (balance/card) WITHOUT capturing — desk Recover needs funded buyer"
    );
    console.log("  5. node scripts/seed/seed-subscriptions.mjs --refresh");
    console.log(
      `  6. Set SEED_SUBSCRIPTION_ID=${subscriptions[DEMO_OUTSTANDING.key].id} in .env`
    );
    console.log(
      `  Money-proof history: setup-fee-continue → ${
        subscriptions["setup-fee-continue"]?.id || "I-J8R13K0F76X4"
      }`
    );
    return ids;
  }

  for (const buyer of BUYERS) {
    if (subscriptions[buyer.key]?.id) {
      console.log(`Skip ${buyer.key} — already have ${subscriptions[buyer.key].id}`);
      continue;
    }
    await createBuyerShell(buyer, ids, subscriptions);
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
