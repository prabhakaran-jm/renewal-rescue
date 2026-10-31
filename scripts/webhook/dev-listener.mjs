/**
 * Local webhook listener for BILLING.SUBSCRIPTION.PAYMENT.FAILED (+ SUSPENDED / SALE.COMPLETED).
 * Verifies signatures via PayPal verify-webhook-signature API.
 *
 * Simulator events are OK for wiring this listener — NEVER treat Simulator as money proof.
 *
 * Usage:
 *   1. Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID in .env.local
 *   2. Expose localhost:8787 with ngrok/cloudflared → set that URL on the sandbox app webhook
 *   3. npm run webhook:dev
 *
 * Events to subscribe in Dashboard (or webhook create API):
 *   BILLING.SUBSCRIPTION.PAYMENT.FAILED
 *   BILLING.SUBSCRIPTION.SUSPENDED
 *   PAYMENT.SALE.COMPLETED
 */

import { createServer } from "node:http";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paypalFetch, requireEnv, getAccessToken, apiBase } from "../seed/lib/paypal.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = resolve(__dirname, "../../fixtures/webhook-events");
const PORT = Number(process.env.WEBHOOK_PORT || 8787);

const INTERESTING = new Set([
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "PAYMENT.SALE.COMPLETED",
]);

async function verifySignature(headers, body) {
  requireEnv(["PAYPAL_WEBHOOK_ID"]);
  const payload = {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: body,
  };

  const missing = Object.entries(payload)
    .filter(([k, v]) => k !== "webhook_event" && !v)
    .map(([k]) => k);
  if (missing.length) {
    return { ok: false, reason: `Missing headers/fields: ${missing.join(", ")}` };
  }

  // Ensure token works before verify call (surfaces auth errors clearly)
  await getAccessToken();

  const result = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: payload,
  });

  if (result.verification_status !== "SUCCESS") {
    return { ok: false, reason: `verification_status=${result.verification_status}` };
  }
  return { ok: true, transmissionId: payload.transmission_id };
}

function storeEvent(record) {
  mkdirSync(STORE, { recursive: true });
  const line = JSON.stringify(record) + "\n";
  appendFileSync(resolve(STORE, "events.ndjson"), line);
}

const seen = new Set();

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, apiBase: apiBase() }));
    return;
  }

  if (req.method !== "POST" || !req.url?.startsWith("/webhooks/paypal")) {
    res.writeHead(404).end("not found");
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400).end("invalid json");
    return;
  }

  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])
  );

  let verify;
  try {
    verify = await verifySignature(headers, body);
  } catch (err) {
    console.error("Verify call failed:", err.message);
    res.writeHead(500).end("verify error");
    return;
  }

  if (!verify.ok) {
    console.warn("REJECT signature:", verify.reason);
    res.writeHead(401).end("invalid signature");
    return;
  }

  const eventId = body.id;
  const eventType = body.event_type;
  const duplicate = eventId && seen.has(eventId);
  if (eventId) seen.add(eventId);

  const record = {
    receivedAt: new Date().toISOString(),
    transmissionId: verify.transmissionId,
    eventId,
    eventType,
    duplicate: Boolean(duplicate),
    resourceId: body.resource?.id ?? null,
    // Explicit label so nobody mistakes Simulator wiring for money proof
    moneyProof: false,
    note: "Stored event — Simulator OK for wiring only; outstanding_balance from Billing GET is the DECIDE signal",
  };

  storeEvent(record);

  if (INTERESTING.has(eventType)) {
    console.log(
      `[${duplicate ? "dup" : "new"}] ${eventType} event=${eventId} resource=${record.resourceId} transmission=${verify.transmissionId}`
    );
  } else {
    console.log(`[other] ${eventType} event=${eventId}`);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, duplicate }));
});

try {
  requireEnv(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"]);
} catch (err) {
  console.error(err.message);
  console.error("Also set WEBHOOK_PUBLIC_URL when registering the webhook in Dashboard.");
  process.exit(2);
}

server.listen(PORT, () => {
  console.log(`PayPal webhook listener on http://127.0.0.1:${PORT}/webhooks/paypal`);
  console.log(`Health: http://127.0.0.1:${PORT}/health`);
  console.log(`Events → ${STORE}/events.ndjson`);
  console.log("Signature verify ON. Simulator = wiring only, not money proof.");
  if (!existsSync(resolve(process.cwd(), ".env.local")) && !existsSync(resolve(process.cwd(), ".env"))) {
    console.warn("No .env.local found — relying on process env.");
  }
});
