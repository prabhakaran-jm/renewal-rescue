import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persist verified webhook events for the desk inbox.
 * Simulator OK for smoke — never money proof.
 */

export const INTERESTING_EVENTS = new Set([
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "PAYMENT.SALE.COMPLETED",
  "PAYMENT.CAPTURE.COMPLETED",
]);

export type WebhookInboxRecord = {
  receivedAt: string;
  transmissionId: string | null;
  eventId: string | null;
  eventType: string | null;
  resourceId: string | null;
  duplicate: boolean;
  verification: "SUCCESS";
  interesting: boolean;
  /** Explicit — Simulator / live delivery are wiring, not bagged cash */
  moneyProof: false;
  note: string;
  summary?: Record<string, unknown>;
};

const g = globalThis as typeof globalThis & {
  __renewalRescueWebhookSeen?: Set<string>;
  __renewalRescueWebhookCache?: WebhookInboxRecord[];
};

function storeDir() {
  return join(process.cwd(), "fixtures", "webhook-events");
}

function storePath() {
  return join(storeDir(), "events.ndjson");
}

function seenSet() {
  if (!g.__renewalRescueWebhookSeen) {
    g.__renewalRescueWebhookSeen = new Set();
  }
  return g.__renewalRescueWebhookSeen;
}

function cache() {
  if (!g.__renewalRescueWebhookCache) {
    g.__renewalRescueWebhookCache = loadFromDisk();
    for (const r of g.__renewalRescueWebhookCache) {
      if (r.eventId) seenSet().add(r.eventId);
    }
  }
  return g.__renewalRescueWebhookCache;
}

function loadFromDisk(): WebhookInboxRecord[] {
  if (!existsSync(storePath())) return [];
  const text = readFileSync(storePath(), "utf8");
  const rows: WebhookInboxRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as WebhookInboxRecord);
    } catch {
      /* skip */
    }
  }
  return rows.reverse(); // newest first for display
}

export function listWebhookInbox(limit = 40): WebhookInboxRecord[] {
  return cache().slice(0, limit);
}

export function appendWebhookEvent(
  record: WebhookInboxRecord
): WebhookInboxRecord {
  const rows = cache();
  rows.unshift(record);
  g.__renewalRescueWebhookCache = rows;
  if (record.eventId) seenSet().add(record.eventId);

  mkdirSync(storeDir(), { recursive: true });
  appendFileSync(storePath(), JSON.stringify(record) + "\n", "utf8");
  return record;
}

export function hasSeenEvent(eventId: string | null | undefined): boolean {
  if (!eventId) return false;
  // ensure cache loaded so seen set includes disk
  cache();
  return seenSet().has(eventId);
}

export function extractResourceId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const resource = (body as { resource?: { id?: string; billing_agreement_id?: string } })
    .resource;
  if (!resource) return null;
  return resource.id || resource.billing_agreement_id || null;
}
