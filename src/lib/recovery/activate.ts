import {
  activateSubscription,
  getSubscription,
  type PaypalSubscription,
} from "@/lib/paypal/billing";

export type ActivateAfterCaptureResult = {
  /** True only when GET status === ACTIVE after the activate attempt. */
  ok: boolean;
  status: string | null;
  restored?: boolean;
  reactivationPending?: boolean;
  /** PayPal error `name` from a 422/error body when present. */
  paypalErrorName?: string;
  error?: string;
  paypal?: unknown;
  subscription?: PaypalSubscription;
};

export type ActivateDeps = {
  activate: typeof activateSubscription;
  get: typeof getSubscription;
  log?: (message: string, extra?: Record<string, unknown>) => void;
};

function extractPaypalErrorName(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const body = (err as { body?: unknown }).body;
  if (body && typeof body === "object" && body !== null) {
    const name = (body as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  const message = err instanceof Error ? err.message : String(err);
  // PayPal often embeds NAME in message; prefer body.name when available.
  const m = message.match(/\b([A-Z][A-Z0-9_]{3,})\b/);
  return m?.[1];
}

function defaultLog(message: string, extra?: Record<string, unknown>) {
  // Intentionally no secrets — status / error name only.
  console.info(`[activate] ${message}`, extra || {});
}

/**
 * After outstanding clears: POST …/activate, then always GET subscription.
 *
 * - ACTIVE → restored / ok
 * - else → reactivation pending (do not call this “failed/refused” unless the
 *   PayPal error name clearly says so)
 *
 * Never treat a bare 422 as alreadyActive success — sandbox often 422s while
 * the sub stays SUSPENDED.
 */
export async function activateAfterCaptureAction(
  subscriptionId: string,
  reason?: string,
  deps: ActivateDeps = {
    activate: activateSubscription,
    get: getSubscription,
    log: defaultLog,
  }
): Promise<ActivateAfterCaptureResult> {
  const log = deps.log || defaultLog;
  let paypal: unknown;
  let activateError: string | undefined;
  let paypalErrorName: string | undefined;
  let activateHttpStatus: number | undefined;

  try {
    paypal = await deps.activate(subscriptionId, reason);
  } catch (err) {
    activateError = err instanceof Error ? err.message : String(err);
    activateHttpStatus =
      err && typeof err === "object" && "status" in err
        ? Number((err as { status?: number }).status)
        : undefined;
    paypalErrorName = extractPaypalErrorName(err);
    if (activateHttpStatus === 422) {
      log("activate HTTP 422 — will GET-verify status", {
        subscriptionId,
        paypalErrorName: paypalErrorName || null,
      });
    } else {
      log("activate error — will GET-verify status", {
        subscriptionId,
        status: activateHttpStatus ?? null,
        paypalErrorName: paypalErrorName || null,
      });
    }
  }

  let subscription: PaypalSubscription;
  try {
    subscription = await deps.get(subscriptionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: null,
      reactivationPending: true,
      paypalErrorName,
      error: activateError
        ? `${activateError}; GET failed: ${message}`
        : `GET after activate failed: ${message}`,
      paypal,
    };
  }

  if (subscription.status === "ACTIVE") {
    return {
      ok: true,
      status: "ACTIVE",
      restored: true,
      paypalErrorName,
      error: activateError,
      paypal,
      subscription,
    };
  }

  // Not ACTIVE after activate attempt — cash may be recovered; billing resume pending.
  log("reactivation pending after activate+GET", {
    subscriptionId,
    status: subscription.status,
    paypalErrorName: paypalErrorName || null,
  });

  return {
    ok: false,
    status: subscription.status,
    reactivationPending: true,
    paypalErrorName,
    error: activateError,
    paypal,
    subscription,
  };
}
