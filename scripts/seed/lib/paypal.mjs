/**
 * Minimal PayPal sandbox REST helpers for Oct 30 seed scripts.
 * Never logs client secret or access tokens.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv() {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

loadDotEnv();

export function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    const err = new Error(
      `Missing required env: ${missing.join(", ")}. Copy .env.example → .env.local and add sandbox app credentials.`
    );
    err.code = "MISSING_ENV";
    err.missing = missing;
    throw err;
  }
}

export function apiBase() {
  return (
    process.env.PAYPAL_API_BASE?.replace(/\/$/, "") ||
    "https://api-m.sandbox.paypal.com"
  );
}

let cachedToken = null;
let cachedExpiresAt = 0;

export async function getAccessToken() {
  requireEnv(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
  const now = Date.now();
  if (cachedToken && now < cachedExpiresAt - 30_000) return cachedToken;

  const basic = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `OAuth failed HTTP ${res.status}: ${body.error || body.message || "unknown"} (secret not logged)`
    );
  }
  cachedToken = body.access_token;
  cachedExpiresAt = now + (body.expires_in || 300) * 1000;
  return cachedToken;
}

export async function paypalFetch(path, { method = "GET", body, prefer } = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail =
      json?.message ||
      json?.details?.[0]?.description ||
      json?.name ||
      text.slice(0, 200);
    const err = new Error(`PayPal ${method} ${path} → HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}
