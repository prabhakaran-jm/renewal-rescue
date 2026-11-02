import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getSubscription } from "@/lib/paypal/billing";
import type { DeskSubscription, Money } from "@/types/renewal";

const DEFAULT_PLAN_PRICE: Money = { currency_code: "USD", value: "5.00" };

/** PayPal billing subscription ids look like I-XXXXXXXXXXXX */
const PAYPAL_SUB_ID_RE = /^I-[A-Z0-9]+$/i;

/**
 * Normalize a single env token into a PayPal subscription id.
 * Strips accidental `KEY=` paste (e.g. SEED_SUBSCRIPTION_IDS=I-…),
 * rejects non I-* values so we never call PayPal with garbage paths.
 */
export function sanitizePaypalSubscriptionId(
  raw: string | null | undefined
): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Accidental "KEY=value" pasted into the Vercel value field
  const eq = s.indexOf("=");
  if (eq > 0 && /^[A-Z0-9_]+$/i.test(s.slice(0, eq))) {
    s = s.slice(eq + 1).trim();
  }
  // Quotes from .env paste
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  if (!PAYPAL_SUB_ID_RE.test(s)) return null;
  return s;
}

function preferredCaptureIdFromEnv(): string {
  return (
    sanitizePaypalSubscriptionId(process.env.SEED_SUBSCRIPTION_ID) ||
    "I-CNCX69GD2UD8"
  );
}

/** Friendly keys when Vercel has only SEED_SUBSCRIPTION_IDS (no fixture file). */
const KNOWN_SEED_META: Record<
  string,
  Pick<SeedSubRow, "planKey" | "failurePath" | "note">
> = {
  "I-3FSFGWWRAV4D": {
    planKey: "setupFee",
    failurePath: "outstanding-smoke",
    note: "Step3 smoke — SUSPENDED+outstanding; prefer wrong-passcode before live capture",
  },
  "I-CNCX69GD2UD8": {
    planKey: "setupFee",
    failurePath: "outstanding-film",
    note: "Step3 film (preferred) — do not Approve until filming",
  },
  "I-S5J71BPHJBT3": {
    planKey: "setupFee",
    failurePath: "outstanding-judge-1",
    note: "Step3 judge spare — leave for judges",
  },
  "I-FWR8V1TKDEFW": {
    planKey: "setupFee",
    failurePath: "outstanding-judge-2",
    note: "Step3 judge spare — leave for judges",
  },
  "I-J8R13K0F76X4": {
    planKey: "setupFee",
    failurePath: "setup-fee-continue",
    note: "Money-proof history — MRR board; not preferred capture",
  },
};

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

/** Load fixture file if present; empty object if missing (Vercel env-only mode). */
export function loadSeedIds(): SeedFile {
  const path = resolve(process.cwd(), "fixtures/seed-ids.json");
  if (!existsSync(path)) {
    return { subscriptions: {} };
  }
  return JSON.parse(readFileSync(path, "utf8")) as SeedFile;
}

function parseEnvSubscriptionIds(): string[] {
  const envRaw = process.env.SEED_SUBSCRIPTION_IDS?.trim();
  if (!envRaw) return [];
  // Whole-field KEY=value paste: SEED_SUBSCRIPTION_IDS=I-a,I-b
  let body = envRaw;
  const eq = body.indexOf("=");
  if (eq > 0 && /^[A-Z0-9_]+$/i.test(body.slice(0, eq).trim())) {
    body = body.slice(eq + 1).trim();
  }
  const ids: string[] = [];
  for (const part of body.split(",")) {
    const id = sanitizePaypalSubscriptionId(part);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Env override: comma-separated subscription IDs for the desk (Vercel-safe).
 * Does not require fixtures/seed-ids.json when SEED_SUBSCRIPTION_IDS is set.
 */
export function resolveSeedSubscriptionEntries(): Array<{
  key: string;
  row: SeedSubRow;
}> {
  const file = loadSeedIds();
  const subs = file.subscriptions || {};
  const envIds = parseEnvSubscriptionIds();

  if (envIds.length) {
    return envIds.map((id) => {
      const found = Object.entries(subs).find(([, row]) => row?.id === id);
      if (found) {
        return { key: found[0], row: found[1] };
      }
      const meta = KNOWN_SEED_META[id];
      return {
        key: meta?.failurePath || id,
        row: {
          id,
          planKey: meta?.planKey || "env",
          failurePath: meta?.failurePath || "env-seed",
          note: meta?.note || "From SEED_SUBSCRIPTION_IDS",
        },
      };
    });
  }

  const fromFile = Object.entries(subs)
    .filter(
      ([key, row]) =>
        Boolean(row?.id) &&
        !key.endsWith("-superseded") &&
        !key.endsWith("-funded-fail") &&
        row.status !== "NOT_FOUND"
    )
    .map(([key, row]) => ({ key, row }));

  if (fromFile.length < 1) {
    throw new Error(
      "No subscriptions — set SEED_SUBSCRIPTION_IDS on Vercel (fixtures/seed-ids.json is gitignored) or run seed locally"
    );
  }
  return fromFile;
}

/** IDs to probe for recovered-MRR (env list or preferred money-proof + preferred capture). */
export function recoveredMrrSubscriptionIds(): string[] {
  const envIds = parseEnvSubscriptionIds();
  if (envIds.length) return [...new Set(envIds)];
  const entries = resolveSeedSubscriptionEntries();
  const ids = entries.map((e) => e.row.id);
  if (!ids.includes("I-J8R13K0F76X4")) ids.push("I-J8R13K0F76X4");
  return [...new Set(ids)];
}

export function preferredCaptureId() {
  return preferredCaptureIdFromEnv();
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
      preferredCaptureTarget: live.id === preferredCaptureIdFromEnv(),
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
