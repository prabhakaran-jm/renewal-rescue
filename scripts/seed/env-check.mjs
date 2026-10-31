/**
 * Report which PayPal env keys are filled — never prints secret values.
 * Usage: node scripts/seed/env-check.mjs
 */

import "./lib/paypal.mjs";

const KEYS = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_API_BASE",
  "PAYPAL_WEBHOOK_ID",
  "WEBHOOK_PUBLIC_URL",
  "PAYPAL_PRODUCT_ID",
];

let ok = true;
for (const key of KEYS) {
  const v = process.env[key]?.trim() ?? "";
  const filled = v.length > 0;
  if (key === "PAYPAL_CLIENT_ID" || key === "PAYPAL_CLIENT_SECRET") {
    if (!filled) ok = false;
    const hint =
      filled && key === "PAYPAL_CLIENT_ID" && v.length >= 4
        ? ` len=${v.length} suffix=...${v.slice(-4)}`
        : filled
          ? ` len=${v.length}`
          : "";
    console.log(`${key}: ${filled ? "FILLED" : "MISSING"}${hint}`);
  } else if (key === "PAYPAL_API_BASE") {
    console.log(`${key}: ${filled ? v : "MISSING (default sandbox will be used)"}`);
  } else {
    console.log(`${key}: ${filled ? "FILLED" : "optional/empty"}`);
  }
}

if (!ok) {
  console.log("\nAction: open .env in the repo and paste Sandbox Client ID + Secret from");
  console.log("Developer Dashboard → Apps & Credentials → Sandbox → Default Application.");
  console.log("Do not paste secrets into chat. Then re-run: npm run seed:all");
  process.exit(2);
}

console.log("\nRequired credentials present. Next: npm run seed:all");
