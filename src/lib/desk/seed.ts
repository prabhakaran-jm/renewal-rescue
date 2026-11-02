import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getSubscription } from "@/lib/paypal/billing";
import type { DeskSubscription, Money } from "@/types/renewal";

const PREFERRED_CAPTURE_ID =
  process.env.SEED_SUBSCRIPTION_ID?.trim() || "I-3HK9STH33F7F";

const DEFAULT_PLAN_PRICE: Money = { currency_code: "USD", value: "5.00" };

type SeedFile = {
  plans?: Record<string, string>;
  subscriptions?: Record<
    string,
    {
      id: string;
      planId?: string;
      planKey?: string;
      failurePath?: string;
      note?: string;
      status?: string;
    }
  >;
};

export function loadSeedIds(): SeedFile {
  const path = resolve(process.cwd(), "fixtures/seed-ids.json");
  if (!existsSync(path)) {
    throw new Error(
      "fixtures/seed-ids.json missing — run npm run seed:all / seed:subs first"
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as SeedFile;
}

export function preferredCaptureId() {
  return PREFERRED_CAPTURE_ID;
}

/** List 4 seeded subs with live PayPal Billing GET refresh. */
export async function listDeskSubscriptions(): Promise<DeskSubscription[]> {
  const ids = loadSeedIds();
  const subs = ids.subscriptions || {};
  const keys = Object.keys(subs);
  if (keys.length < 1) {
    throw new Error("No subscriptions in fixtures/seed-ids.json");
  }

  const refreshedAt = new Date().toISOString();
  const rows: DeskSubscription[] = [];

  for (const key of keys) {
    const row = subs[key];
    if (!row?.id) continue;
    // Skip expired APPROVAL_PENDING shells kept only as history
    if (key.endsWith("-superseded") || row.status === "NOT_FOUND") continue;
    let live;
    try {
      live = await getSubscription(row.id);
    } catch (err) {
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status?: number }).status)
          : undefined;
      if (status === 404) continue;
      throw err;
    }
    const outstanding = live.billing_info?.outstanding_balance ?? null;
    const outstandingValue = outstanding
      ? Number.parseFloat(outstanding.value)
      : 0;

    rows.push({
      key,
      id: live.id,
      planId: live.plan_id || row.planId || "",
      planKey: row.planKey || key,
      failurePath: row.failurePath || key,
      note: row.note || "",
      status: live.status,
      outstanding,
      outstandingValue: Number.isFinite(outstandingValue)
        ? outstandingValue
        : 0,
      failedPaymentsCount: live.billing_info?.failed_payments_count ?? null,
      nextBillingTime: live.billing_info?.next_billing_time ?? null,
      lastPayment: live.billing_info?.last_payment ?? null,
      refreshedAt,
      preferredCaptureTarget: live.id === PREFERRED_CAPTURE_ID,
      fixtureLabeled: !(outstandingValue > 0),
      currentPlanPrice: DEFAULT_PLAN_PRICE,
    });
  }

  // Prefer live outstanding / preferred capture id at top of desk
  rows.sort((a, b) => {
    if (a.preferredCaptureTarget !== b.preferredCaptureTarget) {
      return a.preferredCaptureTarget ? -1 : 1;
    }
    return b.outstandingValue - a.outstandingValue;
  });

  return rows;
}

export async function getDeskSubscription(
  subscriptionId: string
): Promise<DeskSubscription | null> {
  const rows = await listDeskSubscriptions();
  return rows.find((r) => r.id === subscriptionId) ?? null;
}
