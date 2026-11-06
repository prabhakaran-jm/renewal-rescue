import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { deskCardBadge } from "@/lib/desk/card-labels";
import { hasFirstVerifiedRecovery } from "@/lib/desk/recovery-txn";
import {
  getSubscription,
  listSubscriptionTransactions,
} from "@/lib/paypal/billing";
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
    note: "Money-proof history — verified balance recovery board; not preferred capture",
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

/**
 * Money-proof history + cleared film + smoke — always probe for verified
 * balance recovery even when SEED_SUBSCRIPTION_IDS is trimmed
 * (Vercel env lag / judge spares only).
 */
export const ALWAYS_PROBE_RECOVERED_MRR_IDS = [
  "I-J8R13K0F76X4", // money-proof history
  "I-CNCX69GD2UD8", // cleared film
  "I-3FSFGWWRAV4D", // smoke
] as const;

/** IDs to probe for verified recovery (env/fixture list ∪ always-probe ids). */
export function recoveredMrrSubscriptionIds(): string[] {
  const envIds = parseEnvSubscriptionIds();
  const base = envIds.length
    ? envIds
    : resolveSeedSubscriptionEntries().map((e) => e.row.id);
  return [...new Set([...base, ...ALWAYS_PROBE_RECOVERED_MRR_IDS])];
}

export function preferredCaptureId() {
  return preferredCaptureIdFromEnv();
}

/** List seeded subs with live PayPal Billing GET refresh (parallel per-sub). */
export async function listDeskSubscriptions(): Promise<DeskSubscription[]> {
  const entries = resolveSeedSubscriptionEntries();
  if (entries.length < 1) {
    throw new Error(
      "No subscriptions — set SEED_SUBSCRIPTION_IDS or fixtures/seed-ids.json"
    );
  }

  const refreshedAt = new Date().toISOString();
  const preferredId = preferredCaptureIdFromEnv();

  const settled = await Promise.all(
    entries.map(async ({ key, row }) => {
      if (!row?.id) return null;
      let live;
      try {
        live = await getSubscription(row.id);
      } catch (err) {
        const status =
          err && typeof err === "object" && "status" in err
            ? Number((err as { status?: number }).status)
            : undefined;
        if (status === 404) return null;
        throw err;
      }
      const outstanding = live.billing_info?.outstanding_balance ?? null;
      const outstandingRaw = outstanding
        ? Number.parseFloat(outstanding.value)
        : 0;
      const outstandingValue = Number.isFinite(outstandingRaw)
        ? outstandingRaw
        : 0;

      // First COMPLETED ≥ $5 on live txn list → verified recovery (no memory).
      let hasVerifiedRecovery = false;
      try {
        const txns = await listSubscriptionTransactions(live.id);
        hasVerifiedRecovery = hasFirstVerifiedRecovery(txns);
      } catch {
        hasVerifiedRecovery = false;
      }

      const badge = deskCardBadge({
        outstandingValue,
        status: live.status,
        hasVerifiedRecovery,
      });

      const outstandingNormalized = outstanding
        ? {
            currency_code: outstanding.currency_code || "USD",
            value: outstandingValue.toFixed(2),
          }
        : null;

      const deskRow: DeskSubscription = {
        key,
        id: live.id,
        planId: live.plan_id || row.planId || "",
        planKey: row.planKey || key,
        failurePath: row.failurePath || key,
        note: row.note || "",
        status: live.status,
        outstanding: outstandingNormalized,
        outstandingValue,
        failedPaymentsCount: live.billing_info?.failed_payments_count ?? null,
        nextBillingTime: live.billing_info?.next_billing_time ?? null,
        lastPayment: live.billing_info?.last_payment ?? null,
        refreshedAt,
        preferredCaptureTarget: live.id === preferredId,
        fixtureLabeled: badge.fixtureLabeled,
        cardLabel: badge.label,
        hasVerifiedRecovery,
        currentPlanPrice: DEFAULT_PLAN_PRICE,
      };
      return deskRow;
    })
  );

  const rows = settled.filter((r): r is DeskSubscription => r != null);

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
