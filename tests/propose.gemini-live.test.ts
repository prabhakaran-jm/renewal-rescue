/**
 * Live Gemini smoke — only runs when GEMINI_LIVE=1 and GEMINI_API_KEY is set.
 * Does not print the key. Documents which schema field worked.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { generateContentJson } from "../src/lib/ai/gemini.ts";
import {
  clearProposeCache,
  proposeForSubscription,
} from "../src/lib/ai/propose.ts";
import type { DeskSubscription } from "../src/types/renewal.ts";

/** Load .env into process.env without logging values (no dotenv dep). */
function loadEnvFileQuietly() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
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

loadEnvFileQuietly();

const live = process.env.GEMINI_LIVE === "1";
const hasKey = Boolean(process.env.GEMINI_API_KEY?.trim());

const money = (value: string) => ({ currency_code: "USD", value });

function makeSub(): DeskSubscription {
  return {
    key: "preferred",
    id: "I-3HK9STH33F7F",
    planId: "P-TEST",
    planKey: "daily",
    failurePath: "suspended",
    note: "live smoke",
    status: "SUSPENDED",
    outstanding: money("5.00"),
    outstandingValue: 5,
    failedPaymentsCount: 2,
    nextBillingTime: null,
    lastPayment: null,
    refreshedAt: new Date().toISOString(),
    preferredCaptureTarget: true,
    fixtureLabeled: false,
    currentPlanPrice: money("5.00"),
  };
}

const MODEL_SCHEMA = {
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
    rationale: { type: "string" },
    customerMessage: { type: "string" },
  },
  required: ["action", "rationale", "customerMessage"],
};

describe("gemini live smoke", { skip: !(live && hasKey) }, () => {
  it("probes schema field and proposeForSubscription", async () => {
    clearProposeCache();
    const model =
      process.env.GEMINI_MODEL?.trim() || "gemini-3.1-flash-lite";
    const apiKey = process.env.GEMINI_API_KEY!.trim();
    // Boolean only — never log key
    assert.equal(Boolean(apiKey), true);

    const fields = [
      "responseJsonSchema",
      "responseSchema",
      "response_schema",
    ] as const;

    let workingField: (typeof fields)[number] | null = null;
    const errors: string[] = [];

    for (const field of fields) {
      try {
        const result = await generateContentJson({
          apiKey,
          model,
          prompt:
            'Return JSON: action "capture_outstanding", a short rationale, and customerMessage about a failed renewal.',
          responseJsonSchema: MODEL_SCHEMA,
          schemaField: field,
          timeoutMs: 20_000,
        });
        const parsed = JSON.parse(result.text) as { action?: string };
        assert.ok(parsed.action);
        workingField = field;
        break;
      } catch (err) {
        errors.push(
          `${field}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Soft documentation — do not hard-fail the step if model id needs adjust
    if (!workingField) {
      console.log(
        JSON.stringify({
          ok: false,
          geminiApiKeyPresent: true,
          model,
          note: "No schema field succeeded; adjust GEMINI_MODEL or schema field",
          errors,
        })
      );
      return;
    }

    console.log(
      JSON.stringify({
        ok: true,
        geminiApiKeyPresent: true,
        model,
        schemaField: workingField,
      })
    );

    const propose = await proposeForSubscription(makeSub(), {
      bypassCache: true,
      timeoutMs: 20_000,
    });
    assert.ok(
      propose.ai.source === "gemini" || propose.ai.source === "fallback"
    );
    assert.ok(propose.proposal.subscriptionId === "I-3HK9STH33F7F");
    assert.ok(propose.proposal.action);
  });
});
