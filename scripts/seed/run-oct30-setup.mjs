/**
 * Oct 30 SET UP orchestrator: catalog → daily plans → subscription shells.
 * Does NOT claim money proof. Buyer approve + failure methods remain manual.
 *
 * Usage: npm run seed:all
 */

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { requireEnv } from "./lib/paypal.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

function run(script) {
  const path = resolve(__dirname, script);
  console.log(`\n▶ ${script}`);
  const r = spawnSync(process.execPath, [path], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function main() {
  try {
    requireEnv(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
  } catch (err) {
    console.error(err.message);
    console.error("\nExact env vars to add in .env.local:");
    console.error("  PAYPAL_CLIENT_ID");
    console.error("  PAYPAL_CLIENT_SECRET");
    console.error("  PAYPAL_API_BASE=https://api-m.sandbox.paypal.com");
    console.error("  PAYPAL_WEBHOOK_ID   (after webhook registration)");
    console.error("  WEBHOOK_PUBLIC_URL  (tunnel URL for listener)");
    process.exit(2);
  }

  if (!existsSync(resolve(root, ".env.local")) && !existsSync(resolve(root, ".env"))) {
    console.warn("Warning: no .env.local/.env file found (using process env only).");
  }

  run("create-catalog.mjs");
  run("create-daily-plans.mjs");
  run("seed-subscriptions.mjs");

  console.log("\nOct 30 SET UP API portion complete.");
  console.log("Still required (manual):");
  console.log("  • Approve each subscription as a sandbox personal buyer");
  console.log("  • Apply failure methods (drain / remove card / setup-fee path)");
  console.log("  • Register webhook + run npm run webhook:dev with signature verify");
  console.log("  • npm run check:daily through Nov 3");
}

main();
