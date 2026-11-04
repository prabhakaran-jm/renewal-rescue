import { generateContentJson, GeminiError } from "@/lib/ai/gemini";
import { RenewalProposalSchema } from "@/lib/ai/schema";
import { DEFAULT_POLICY, enforcePolicy } from "@/lib/policy/engine";
import type {
  DeskSubscription,
  PolicyResult,
  RecoveryAction,
  RenewalProposal,
} from "@/types/renewal";

function money(value: number, currency = "USD") {
  return { currency_code: currency, value: value.toFixed(2) };
}

/** Human-facing amount in messages / rationales (always two decimals). */
function moneyDisplay(value: number, currency = "USD") {
  return `${value.toFixed(2)} ${currency}`;
}

export type ProposeOpts = {
  /** Demo deny beat: attempt banned write-off — always rule-based */
  demoWriteOff?: boolean;
  /** Force revise retention path — always rule-based */
  forceRevise?: boolean;
  /** Merchant override: force capture_outstanding — always rule-based */
  forceCapture?: boolean;
  revisePlanId?: string;
  /** Injectable fetch for tests */
  fetchImpl?: typeof fetch;
  /** Skip Gemini (tests / force deterministic) */
  skipAi?: boolean;
  apiKey?: string | null;
  model?: string;
  timeoutMs?: number;
  /** Bypass per-instance cache */
  bypassCache?: boolean;
  nowMs?: number;
};

export type AiProvenance = {
  /** rule = film Deny / write-off test (never mislabel as Gemini fallback) */
  source: "gemini" | "fallback" | "rule";
  model: string;
  reason?: string;
};

export type ProposeResult = {
  proposal: RenewalProposal;
  policy: PolicyResult;
  ai: AiProvenance;
  customerMessage?: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_TIMEOUT_MS = 8_000;

type CacheEntry = {
  key: string;
  expiresAt: number;
  result: ProposeResult;
};

const g = globalThis as typeof globalThis & {
  __renewalRescueProposeCache?: Map<string, CacheEntry>;
};
const proposeCache =
  g.__renewalRescueProposeCache ?? new Map<string, CacheEntry>();
g.__renewalRescueProposeCache = proposeCache;

/** Model-only JSON shape — IDs/amounts ignored by code. */
const MODEL_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "capture_outstanding",
        "revise_cheaper",
        "retry_later",
        "escalate",
      ],
    },
    rationale: { type: "string", minLength: 8, maxLength: 600 },
    customerMessage: { type: "string", minLength: 8, maxLength: 400 },
  },
  required: ["action", "rationale", "customerMessage"],
} as const;

function cacheKey(sub: DeskSubscription): string {
  return `${sub.id}|${sub.outstandingValue}`;
}

function resolveModel(explicit?: string): string {
  return (
    explicit ||
    process.env.GEMINI_MODEL?.trim() ||
    DEFAULT_MODEL
  );
}

function resolveApiKey(explicit?: string | null): string | null {
  if (explicit === null) return null;
  if (typeof explicit === "string") return explicit.trim() || null;
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  return fromEnv || null;
}

/**
 * Deterministic propose (rule-based). Used for Demo Deny / Revise / Capture now,
 * and as fallback when Gemini fails validation/policy/timeout/HTTP.
 */
export function proposeDeterministic(
  sub: DeskSubscription,
  opts: ProposeOpts = {}
): ProposeResult {
  const outstanding = sub.outstandingValue;
  const currency = sub.outstanding?.currency_code || "USD";
  const outstandingLabel = moneyDisplay(outstanding, currency);
  const ctx = {
    outstanding: sub.outstanding,
    currentPlanPrice: sub.currentPlanPrice,
    ...DEFAULT_POLICY,
  };
  const model = resolveModel(opts.model);

  if (opts.demoWriteOff) {
    const fake = {
      subscriptionId: sub.id,
      action: "write_off" as const,
      rationale: "DEMO DENY: request full write-off / forgive outstanding.",
      impact: money(0, currency),
      fixtureLabeled: true,
    };
    const policy = enforcePolicy(fake as unknown as RenewalProposal, ctx);
    return {
      proposal: {
        subscriptionId: sub.id,
        action: "escalate",
        rationale: `Write-off refused: ${!policy.ok ? policy.reason : "banned"}`,
        fixtureLabeled: true,
      },
      policy,
      // Desk badge: RULE · write-off test (no FALLBACK + Gemini model)
      ai: { source: "rule", model: "", reason: "write-off test" },
    };
  }

  if (opts.forceCapture) {
    const amount = outstanding > 0 ? outstanding : 0;
    const raw: RenewalProposal = {
      subscriptionId: sub.id,
      action: "capture_outstanding",
      rationale: `Merchant override: capture live outstanding ${moneyDisplay(amount, currency)} (${sub.status}). Capture OUTSTANDING_BALANCE only after merchant Approve — never auto-capture.`,
      impact: money(amount, currency),
      fixtureLabeled: !(outstanding > 0),
    };
    const proposal = RenewalProposalSchema.parse(raw) as RenewalProposal;
    const policy = enforcePolicy(proposal, ctx);
    return {
      proposal,
      policy,
      // Desk badge: RULE · merchant override
      ai: { source: "rule", model: "", reason: "merchant override" },
      customerMessage: `Hi — we noticed a failed renewal. Please settle the outstanding ${moneyDisplay(amount, currency)} balance when you can.`,
    };
  }

  let raw: RenewalProposal;

  if (outstanding > 0 && !opts.forceRevise) {
    raw = {
      subscriptionId: sub.id,
      action: "capture_outstanding",
      rationale: sub.preferredCaptureTarget
        ? `Preferred live capture target ${sub.id}: outstanding ${outstandingLabel} (${sub.status}). Capture OUTSTANDING_BALANCE only after merchant Approve - never auto-capture.`
        : `Live outstanding ${outstandingLabel}. Propose capture <= outstanding; merchant must Approve before money moves.`,
      impact: money(outstanding, currency),
      fixtureLabeled: false,
    };
  } else if (opts.forceRevise) {
    const current = Number.parseFloat(sub.currentPlanPrice.value);
    const next = Number((current * 0.7).toFixed(2));
    raw = {
      subscriptionId: sub.id,
      action: "revise_cheaper",
      rationale:
        outstanding > 0
          ? "Retention revise: cheaper plan next cycle (buyer must approve). Not recovered cash."
          : "FIXTURE: no outstanding - retention revise demo only (buyer approve URL). Not verified recovery.",
      proposedPlanId:
        opts.revisePlanId || process.env.REVISE_CHEAPER_PLAN_ID || undefined,
      proposedPrice: money(next),
      impact: money(next),
      fixtureLabeled: !(outstanding > 0),
    };
  } else {
    raw = {
      subscriptionId: sub.id,
      action: "retry_later",
      rationale:
        "FIXTURE: outstanding is $0 - not verified PayPal recovery. Wait for failed-renewal lifecycle; do not claim Simulator or fixtures as money proof.",
      fixtureLabeled: true,
    };
  }

  const proposal = RenewalProposalSchema.parse(raw) as RenewalProposal;
  const policy = enforcePolicy(proposal, ctx);
  return {
    proposal,
    policy,
    ai: { source: "fallback", model, reason: "deterministic" },
  };
}

function buildFromModelAction(
  sub: DeskSubscription,
  action: RecoveryAction,
  rationale: string,
  opts: ProposeOpts
): RenewalProposal {
  const outstanding = sub.outstandingValue;
  const currency = sub.outstanding?.currency_code || "USD";

  if (action === "capture_outstanding") {
    return {
      subscriptionId: sub.id,
      action: "capture_outstanding",
      rationale,
      impact: money(outstanding > 0 ? outstanding : 0, currency),
      fixtureLabeled: !(outstanding > 0),
    };
  }

  if (action === "revise_cheaper") {
    const current = Number.parseFloat(sub.currentPlanPrice.value);
    const next = Number((current * 0.7).toFixed(2));
    return {
      subscriptionId: sub.id,
      action: "revise_cheaper",
      rationale,
      proposedPlanId:
        opts.revisePlanId || process.env.REVISE_CHEAPER_PLAN_ID || undefined,
      proposedPrice: money(next),
      impact: money(next),
      fixtureLabeled: !(outstanding > 0),
    };
  }

  if (action === "escalate") {
    return {
      subscriptionId: sub.id,
      action: "escalate",
      rationale,
      fixtureLabeled: !(outstanding > 0),
    };
  }

  return {
    subscriptionId: sub.id,
    action: "retry_later",
    rationale,
    fixtureLabeled: !(outstanding > 0),
  };
}

/** Exported for tests — must not include preferredCaptureTarget. */
export function buildPrompt(sub: DeskSubscription): string {
  const outstanding = sub.outstandingValue;
  const currency = sub.outstanding?.currency_code || "USD";
  return [
    "You are proposing a recovery action for a failed PayPal subscription renewal.",
    "Choose exactly one action: capture_outstanding | revise_cheaper | retry_later | escalate.",
    "Also provide a short rationale (merchant-facing) and a short customer draft message.",
    "Do NOT invent IDs or dollar amounts — the application sets those.",
    "Never suggest write-offs or forgiving the balance.",
    "",
    `Subscription status: ${sub.status}`,
    `Outstanding: ${moneyDisplay(outstanding, currency)}`,
    `Failed payments count: ${sub.failedPaymentsCount ?? "unknown"}`,
    `Fixture labeled ($0): ${sub.fixtureLabeled ? "yes" : "no"}`,
    "",
    "Return JSON only matching the schema.",
  ].join("\n");
}

async function proposeViaGemini(
  sub: DeskSubscription,
  opts: ProposeOpts
): Promise<ProposeResult> {
  const model = resolveModel(opts.model);
  const apiKey = resolveApiKey(opts.apiKey);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    const fb = proposeDeterministic(sub, opts);
    return {
      ...fb,
      ai: { source: "fallback", model, reason: "missing_api_key" },
    };
  }

  try {
    const { text } = await generateContentJson({
      apiKey,
      model,
      prompt: buildPrompt(sub),
      responseJsonSchema: MODEL_RESPONSE_SCHEMA as unknown as Record<
        string,
        unknown
      >,
      schemaField: "responseJsonSchema",
      timeoutMs,
      fetchImpl: opts.fetchImpl,
    });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      const fb = proposeDeterministic(sub, opts);
      return {
        ...fb,
        ai: { source: "fallback", model, reason: "malformed_json" },
      };
    }

    const obj = parsedJson as {
      action?: string;
      rationale?: string;
      customerMessage?: string;
      subscriptionId?: string;
      impact?: unknown;
      proposedPrice?: unknown;
    };

    // Strip any ID/amount the model invented — code owns those.
    const actionCandidate = obj.action;
    const rationale = obj.rationale;
    const customerMessage = obj.customerMessage;

    const modelShaped = {
      subscriptionId: sub.id,
      action: actionCandidate,
      rationale,
    };

    let zodOk;
    try {
      zodOk = RenewalProposalSchema.parse(modelShaped);
    } catch {
      const fb = proposeDeterministic(sub, opts);
      return {
        ...fb,
        ai: { source: "fallback", model, reason: "zod_fail" },
      };
    }

    if (
      typeof customerMessage !== "string" ||
      customerMessage.trim().length < 8
    ) {
      const fb = proposeDeterministic(sub, opts);
      return {
        ...fb,
        ai: { source: "fallback", model, reason: "missing_customer_message" },
      };
    }

    const proposal = buildFromModelAction(
      sub,
      zodOk.action as RecoveryAction,
      zodOk.rationale,
      opts
    );

    // Re-validate after amounts are applied by code
    const finalProposal = RenewalProposalSchema.parse(
      proposal
    ) as RenewalProposal;
    const ctx = {
      outstanding: sub.outstanding,
      currentPlanPrice: sub.currentPlanPrice,
      ...DEFAULT_POLICY,
    };
    const policy = enforcePolicy(finalProposal, ctx);
    if (!policy.ok) {
      const fb = proposeDeterministic(sub, opts);
      return {
        ...fb,
        ai: {
          source: "fallback",
          model,
          reason: `policy_reject:${policy.reason}`,
        },
      };
    }

    return {
      proposal: finalProposal,
      policy,
      ai: { source: "gemini", model },
      customerMessage: customerMessage.trim().slice(0, 400),
    };
  } catch (err) {
    const fb = proposeDeterministic(sub, opts);
    let reason = "gemini_error";
    if (err instanceof GeminiError) {
      if (err.kind === "timeout") reason = "timeout";
      else if (err.kind === "http")
        reason = err.status === 429 ? "http_429" : `http_${err.status ?? "err"}`;
      else reason = "malformed";
    }
    return {
      ...fb,
      ai: { source: "fallback", model, reason },
    };
  }
}

/**
 * Async propose: Gemini first (when key present), else deterministic.
 * Demo Deny / forceRevise / forceCapture stay rule-based.
 * 5-minute cache on (id, outstanding). Gemini's chosen action is kept as-is.
 */
export async function proposeForSubscription(
  sub: DeskSubscription,
  opts: ProposeOpts = {}
): Promise<ProposeResult> {
  // Film-consistent rule paths — never call Gemini
  if (opts.demoWriteOff || opts.forceRevise || opts.forceCapture) {
    return proposeDeterministic(sub, opts);
  }

  const now = opts.nowMs ?? Date.now();
  const key = cacheKey(sub);

  if (!opts.bypassCache && !opts.skipAi) {
    const hit = proposeCache.get(key);
    if (hit && hit.expiresAt > now && hit.key === key) {
      return hit.result;
    }
  }

  const result =
    opts.skipAi || !resolveApiKey(opts.apiKey)
      ? (() => {
          const fb = proposeDeterministic(sub, opts);
          if (!resolveApiKey(opts.apiKey)) {
            return {
              ...fb,
              ai: {
                source: "fallback" as const,
                model: resolveModel(opts.model),
                reason: opts.skipAi ? "skip_ai" : "missing_api_key",
              },
            };
          }
          return { ...fb, ai: { ...fb.ai, reason: "skip_ai" } };
        })()
      : await proposeViaGemini(sub, opts);

  if (!opts.bypassCache) {
    proposeCache.set(key, {
      key,
      expiresAt: now + CACHE_TTL_MS,
      result,
    });
  }

  return result;
}

/** Test helper — clear in-memory propose cache */
export function clearProposeCache() {
  proposeCache.clear();
}
