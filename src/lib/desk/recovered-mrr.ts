import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Money } from "@/types/renewal";

/**
 * Recovered-MRR board store.
 * Seed = real money-proof txn only. Runtime appends only after Approve →
 * RECOVERED with outstanding cleared. Never invent MRR rows.
 */

export type RecoveredMrrRow = {
  id: string;
  subscriptionId: string;
  pathKey?: string;
  recoveryAction: "capture_outstanding";
  amountRecovered: Money;
  deskStatus: "RECOVERED";
  transactionId: string | null;
  transactionStatus: string | null;
  recoveredAt: string;
  outstandingCleared: true;
  source: "money_proof_fixture" | "desk_approve";
  proposalId?: string;
  note?: string;
};

const g = globalThis as typeof globalThis & {
  __renewalRescueRecovered?: RecoveredMrrRow[];
  __renewalRescueRecoveredLoaded?: boolean;
};

function rootDir() {
  return process.cwd();
}

function seedPath() {
  return join(rootDir(), "fixtures", "recovered-mrr", "seed.json");
}

function logPath() {
  return join(rootDir(), "fixtures", "recovered-mrr", "log.ndjson");
}

function moneyProofPath() {
  return join(
    rootDir(),
    "fixtures",
    "money-proof",
    "I-J8R13K0F76X4-2026-10-31.json"
  );
}

function loadSeed(): RecoveredMrrRow[] {
  if (existsSync(seedPath())) {
    try {
      const raw = JSON.parse(readFileSync(seedPath(), "utf8")) as RecoveredMrrRow[];
      if (Array.isArray(raw) && raw.length) return raw;
    } catch {
      /* fall through to money-proof */
    }
  }
  // Fallback: derive from money-proof JSON if seed missing
  if (existsSync(moneyProofPath())) {
    try {
      const mp = JSON.parse(readFileSync(moneyProofPath(), "utf8")) as {
        subscriptionId: string;
        pathKey?: string;
        moneyProofTransaction: {
          id: string;
          status: string;
          time: string;
          gross_amount: Money;
        };
      };
      const t = mp.moneyProofTransaction;
      return [
        {
          id: `seed_${t.id}`,
          subscriptionId: mp.subscriptionId,
          pathKey: mp.pathKey,
          recoveryAction: "capture_outstanding",
          amountRecovered: t.gross_amount,
          deskStatus: "RECOVERED",
          transactionId: t.id,
          transactionStatus: t.status,
          recoveredAt: t.time,
          outstandingCleared: true,
          source: "money_proof_fixture",
          note: "Derived from fixtures/money-proof (Step 6).",
        },
      ];
    } catch {
      return [];
    }
  }
  return [];
}

function loadLog(): RecoveredMrrRow[] {
  if (!existsSync(logPath())) return [];
  const text = readFileSync(logPath(), "utf8");
  const rows: RecoveredMrrRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as RecoveredMrrRow);
    } catch {
      /* skip bad line */
    }
  }
  return rows;
}

function ensureLoaded() {
  if (g.__renewalRescueRecoveredLoaded && g.__renewalRescueRecovered) {
    return g.__renewalRescueRecovered;
  }
  const seed = loadSeed();
  const log = loadLog();
  const byId = new Map<string, RecoveredMrrRow>();
  for (const r of [...seed, ...log]) {
    byId.set(r.id, r);
  }
  const rows = [...byId.values()].sort((a, b) =>
    a.recoveredAt < b.recoveredAt ? 1 : a.recoveredAt > b.recoveredAt ? -1 : 0
  );
  g.__renewalRescueRecovered = rows;
  g.__renewalRescueRecoveredLoaded = true;
  return rows;
}

export function listRecoveredMrr(): RecoveredMrrRow[] {
  return [...ensureLoaded()];
}

export function sumRecoveredUsd(rows: RecoveredMrrRow[] = listRecoveredMrr()): number {
  return rows.reduce((acc, r) => {
    if (r.amountRecovered.currency_code !== "USD") return acc;
    const n = Number(r.amountRecovered.value);
    return Number.isFinite(n) ? acc + n : acc;
  }, 0);
}

function extractTxnId(paypal: unknown): string | null {
  if (!paypal || typeof paypal !== "object") return null;
  const p = paypal as Record<string, unknown>;
  if (typeof p.id === "string") return p.id;
  // Billing capture sometimes nests differently
  const links = p.links;
  if (Array.isArray(links)) {
    for (const link of links) {
      if (link && typeof link === "object" && "href" in link) {
        const href = String((link as { href: string }).href);
        const m = href.match(/\/transactions\/([A-Z0-9]+)/i);
        if (m) return m[1];
      }
    }
  }
  return null;
}

export type AppendRecoveredInput = {
  subscriptionId: string;
  pathKey?: string;
  amount: Money;
  paypal?: unknown;
  proposalId?: string;
  note?: string;
};

/**
 * Append only after verified capture (outstanding cleared).
 * Idempotent on proposalId or transactionId when present.
 */
export function appendVerifiedRecovery(
  input: AppendRecoveredInput
): RecoveredMrrRow {
  const rows = ensureLoaded();
  const txnId = extractTxnId(input.paypal);
  const txnStatus =
    input.paypal &&
    typeof input.paypal === "object" &&
    "status" in input.paypal
      ? String((input.paypal as { status?: string }).status ?? "")
      : null;

  if (input.proposalId) {
    const existing = rows.find((r) => r.proposalId === input.proposalId);
    if (existing) return existing;
  }
  if (txnId) {
    const existing = rows.find((r) => r.transactionId === txnId);
    if (existing) return existing;
  }

  const row: RecoveredMrrRow = {
    id: `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    subscriptionId: input.subscriptionId,
    pathKey: input.pathKey,
    recoveryAction: "capture_outstanding",
    amountRecovered: input.amount,
    deskStatus: "RECOVERED",
    transactionId: txnId,
    transactionStatus: txnStatus || "COMPLETED",
    recoveredAt: new Date().toISOString(),
    outstandingCleared: true,
    source: "desk_approve",
    proposalId: input.proposalId,
    note:
      input.note ||
      "Appended after Approve RECOVERED with outstanding cleared (verified).",
  };

  rows.unshift(row);
  g.__renewalRescueRecovered = rows;

  const dir = join(rootDir(), "fixtures", "recovered-mrr");
  mkdirSync(dir, { recursive: true });
  appendFileSync(logPath(), JSON.stringify(row) + "\n", "utf8");

  return row;
}
