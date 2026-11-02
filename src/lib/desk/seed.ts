import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getSubscription } from "@/lib/paypal/billing";
import type { DeskSubscription, Money } from "@/types/renewal";

const PREFERRED_CAPTURE_ID =
  process.env.SEED_SUBSCRIPTION_ID?.trim() || "I-3HK9STH33F7F";

const DEFAULT_PLAN_PRICE: Money = { currency_code: "USD", value: "5.00" };

type SeedSubRow = {
  id: string;
  planId?: string;
  planKey?: string;
  failurePath?: string;
  note?: string;
  status?: string;
};

type SeedFile = {
  plans?: Record<string, string>;
  subscriptions?: Record<string, SeedSubRow>;
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

/**
 * Env override: comma-separated subscription IDs for the desk (Vercel-safe).
 * Falls back to fixtures/seed-ids.json keys when unset.
 */
export function resolveSeedSubscriptionEntries(): Array<{
  key: string;
  row: SeedSubRow;
}> {
  const file = loadSeedIds();
  const subs = file.subscriptions || {};
  const envRaw = process.env.SEED_SUBSCRIPTION_IDS?.trim();
  if (envRaw) {
    const ids = envRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return ids.map((id) => {
      const found = Object.entries(subs).find(([, row]) => row?.id === id);
      if (found) {
        return { key: found[0], row: found[1] };
      }
      return {
        key: id,
        row: {
          id,
          planKey: "env",
          failurePath: "env-seed",
          note: "From SEED_SUBSCRIPTION_IDS",
        },
      };
    });
  }

  return Object.entries(subs)
    .filter(
      ([key, row]) =>
        Boolean(row?.id) &&
        !key.endsWith("-superseded") &&
        row.status !== "NOT_FOUND"
    )
    .map(([key, row]) => ({ key, row }));
}

/** IDs to probe for recovered-MRR (env list or preferred money-proof + preferred capture). */
export function recoveredMrrSubscriptionIds(): string[] {
  const envRaw = process.env.SEED_SUBSCRIPTION_IDS?.trim();
  if (envRaw) {
    return envRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const entries = resolveSeedSubscriptionEntries();
  const ids = entries.map((e) => e.row.id);
  // Always include money-proof history sub when using fixture seeds
  if (!ids.includes("I-J8R13K0F76X4")) ids.push("I-J8R13K0F76X4");
  return [...new Set(ids)];
}

export function preferredCaptureId() {
  return PREFERRED_CAPTURE_ID;
}

/** List seeded subs with live PayPal Billing GET refresh. */
export async function listDeskSubscriptions(): Promise<DeskSubscription[]> {
  const entries = resolveSeedSubscriptionEntries();
  if (entries.length < 1) {
    throw new Error(
      "No subscriptions — set SEED_SUBSCRIPTION_IDS or fixtures/seed-ids.json"
    );
  }

  const refreshedAt = new Date().toISOString();
  const rows: DeskSubscription[] = [];

  for (const { key, row } of entries) {
    if (!row?.id) continue;
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
