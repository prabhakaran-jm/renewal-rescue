/**
 * Create ACTIVE daily-billing plans for Oct 30 SET UP.
 *
 * Plans:
 *  - rr-daily-standard: DAY / $5 — used for drained-balance & card-removed buyers
 *  - rr-daily-setup-fee: DAY / $5 + setup_fee $1, setup_fee_failure_action CONTINUE,
 *    auto_bill_outstanding true, payment_failure_threshold 1
 *
 * Usage: npm run seed:plans  (requires productId in fixtures/seed-ids.json)
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paypalFetch, requireEnv } from "./lib/paypal.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../fixtures");
const IDS_PATH = resolve(FIXTURES, "seed-ids.json");

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

function dailyRegularCycle(price) {
  return {
    frequency: { interval_unit: "DAY", interval_count: 1 },
    tenure_type: "REGULAR",
    sequence: 1,
    total_cycles: 0,
    pricing_scheme: {
      fixed_price: { value: price, currency_code: "USD" },
    },
  };
}

async function createPlan({ name, description, productId, payment_preferences }) {
  const plan = await paypalFetch("/v1/billing/plans", {
    method: "POST",
    prefer: "return=representation",
    body: {
      product_id: productId,
      name,
      description,
      status: "ACTIVE",
      billing_cycles: [dailyRegularCycle("5.00")],
      payment_preferences,
      taxes: { percentage: "0", inclusive: false },
    },
  });
  return plan;
}

async function main() {
  requireEnv(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
  const ids = loadIds();
  if (!ids.productId) {
    throw new Error("No productId — run npm run seed:catalog first");
  }

  if (ids.plans?.standard && ids.plans?.setupFee) {
    console.log("Plans already recorded:");
    console.log("  standard →", ids.plans.standard);
    console.log("  setupFee →", ids.plans.setupFee);
    return ids;
  }

  const standard = await createPlan({
    name: "RR Daily Standard",
    description: "Daily $5 — drained balance / card removed seed path",
    productId: ids.productId,
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee: { value: "0", currency_code: "USD" },
      setup_fee_failure_action: "CONTINUE",
      payment_failure_threshold: 1,
    },
  });

  const setupFee = await createPlan({
    name: "RR Daily SetupFee Continue",
    description:
      "Daily $5 + setup_fee $1 CONTINUE + auto_bill_outstanding + failure_threshold 1",
    productId: ids.productId,
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee: { value: "1.00", currency_code: "USD" },
      setup_fee_failure_action: "CONTINUE",
      payment_failure_threshold: 1,
    },
  });

  const next = saveIds({
    plans: {
      standard: standard.id,
      setupFee: setupFee.id,
    },
  });

  console.log("Created plans:");
  console.log("  standard →", standard.id, standard.status);
  console.log("  setupFee →", setupFee.id, setupFee.status);
  return next;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(err.code === "MISSING_ENV" ? 2 : 1);
});
