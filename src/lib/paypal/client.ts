/**
 * PayPal sandbox OAuth + REST fetch for the recovery desk.
 * Never logs client secret or access tokens.
 */

function apiBase() {
  return (
    process.env.PAYPAL_API_BASE?.replace(/\/$/, "") ||
    "https://api-m.sandbox.paypal.com"
  );
}

export function requirePaypalEnv() {
  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter(
    (k) => !process.env[k]?.trim()
  );
  if (missing.length) {
    throw new Error(
      `Missing required env: ${missing.join(", ")}. Copy .env.example → .env and add sandbox credentials.`
    );
  }
}

let cachedToken: string | null = null;
let cachedExpiresAt = 0;

export async function getAccessToken(): Promise<string> {
  requirePaypalEnv();
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

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    message?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `OAuth failed HTTP ${res.status}: ${body.error || body.message || "unknown"} (secret not logged)`
    );
  }
  cachedToken = body.access_token;
  cachedExpiresAt = now + (body.expires_in || 300) * 1000;
  return cachedToken;
}

export async function paypalFetch<T = unknown>(
  path: string,
  {
    method = "GET",
    body,
    prefer,
    headers: extraHeaders,
  }: {
    method?: string;
    body?: unknown;
    prefer?: string;
    /** Extra headers (e.g. PayPal-Request-Id). Never log secrets. */
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const j = json as {
      message?: string;
      name?: string;
      details?: Array<{ description?: string }>;
    } | null;
    const detail =
      j?.message ||
      j?.details?.[0]?.description ||
      j?.name ||
      text.slice(0, 200);
    const err = new Error(
      `PayPal ${method} ${path} → HTTP ${res.status}: ${detail}`
    ) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = json;
    throw err;
  }
  // Empty 2xx (common on async capture) must not become silent `null`
  // that the desk can mislabel as RECOVERED money proof.
  if (json == null && method !== "GET") {
    return { status: "NO_CONTENT", httpStatus: res.status } as T;
  }
  return json as T;
}
