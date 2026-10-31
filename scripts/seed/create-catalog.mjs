/**
 * Create (or reuse) a Catalog Products product for subscription plans.
 * Usage: npm run seed:catalog
 * Optional: PAYPAL_PRODUCT_ID to skip create.
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

async function main() {
  requireEnv(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);

  if (process.env.PAYPAL_PRODUCT_ID?.trim()) {
    const ids = saveIds({ productId: process.env.PAYPAL_PRODUCT_ID.trim() });
    console.log("Reusing PAYPAL_PRODUCT_ID →", ids.productId);
    return ids;
  }

  const existing = loadIds().productId;
  if (existing) {
    console.log("Reusing fixtures/seed-ids.json productId →", existing);
    return loadIds();
  }

  const product = await paypalFetch("/v1/catalogs/products", {
    method: "POST",
    prefer: "return=representation",
    body: {
      name: "Renewal Rescue Seed Product",
      description: "Oct 30 daily-billing sandbox seed for failed-renewal desk",
      type: "SERVICE",
      category: "SOFTWARE",
    },
  });

  const ids = saveIds({ productId: product.id, productName: product.name });
  console.log("Created catalog product →", product.id);
  return ids;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(err.code === "MISSING_ENV" ? 2 : 1);
});
