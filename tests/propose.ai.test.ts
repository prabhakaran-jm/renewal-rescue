import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearProposeCache,
  proposeDeterministic,
  proposeForSubscription,
} from "../src/lib/ai/propose.ts";
import type { DeskSubscription } from "../src/types/renewal.ts";

const money = (value: string) => ({ currency_code: "USD", value });

function makeSub(overrides: Partial<DeskSubscription> = {}): DeskSubscription {
  return {
    key: "preferred",
    id: "I-3HK9STH33F7F",
    planId: "P-TEST",
    planKey: "daily",
    failurePath: "suspended",
    note: "test",
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
    ...overrides,
  };
}

function geminiOkBody(payload: Record<string, unknown>) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(payload) }],
        },
      },
    ],
  };
}

beforeEach(() => {
  clearProposeCache();
});

describe("proposeDeterministic (rule paths)", () => {
  it("demo write-off stays rule-based escalate", () => {
    const r = proposeDeterministic(makeSub(), { demoWriteOff: true });
    assert.equal(r.proposal.action, "escalate");
    assert.equal(r.ai.source, "fallback");
    assert.equal(r.ai.reason, "demo_write_off");
  });

  it("force revise stays rule-based 30% discount", () => {
    const r = proposeDeterministic(makeSub(), { forceRevise: true });
    assert.equal(r.proposal.action, "revise_cheaper");
    assert.equal(r.proposal.proposedPrice?.value, "3.50");
    assert.equal(r.ai.source, "fallback");
  });
});

describe("proposeForSubscription with fake fetch", () => {
  it("valid model JSON → gemini provenance + customer message", async () => {
    const seen: { url?: string; headers?: HeadersInit } = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      seen.url = String(input);
      seen.headers = init?.headers;
      return new Response(
        JSON.stringify(
          geminiOkBody({
            action: "capture_outstanding",
            rationale:
              "Capture the live outstanding balance after merchant approve.",
            customerMessage:
              "Hi — we noticed a failed renewal. Reply to settle the balance.",
            // Invented fields must be ignored:
            subscriptionId: "I-HACKED-ID",
            impact: { currency_code: "USD", value: "99.99" },
          })
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const r = await proposeForSubscription(makeSub(), {
      apiKey: "test-key-not-real",
      model: "gemini-test",
      fetchImpl: fakeFetch,
      bypassCache: true,
    });

    assert.equal(r.ai.source, "gemini");
    assert.equal(r.ai.model, "gemini-test");
    assert.equal(r.proposal.action, "capture_outstanding");
    assert.equal(r.proposal.subscriptionId, "I-3HK9STH33F7F");
    assert.equal(r.proposal.impact?.value, "5.00");
    assert.match(r.customerMessage || "", /failed renewal/i);
    assert.ok(seen.url);
    assert.equal(seen.url!.includes("key="), false);
    assert.equal(seen.url!.includes("test-key-not-real"), false);
    const headers = new Headers(seen.headers);
    assert.equal(headers.get("x-goog-api-key"), "test-key-not-real");
  });

  it("malformed JSON → fallback", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "NOT_JSON{{" }] } }],
        }),
        { status: 200 }
      );

    const r = await proposeForSubscription(makeSub(), {
      apiKey: "k",
      fetchImpl: fakeFetch,
      bypassCache: true,
    });
    assert.equal(r.ai.source, "fallback");
    assert.equal(r.ai.reason, "malformed_json");
    assert.equal(r.proposal.action, "capture_outstanding");
  });

  it("timeout → fallback", async () => {
    const fakeFetch: typeof fetch = async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        const err = new Error("aborted");
        err.name = "AbortError";
        init?.signal?.addEventListener("abort", () => reject(err));
      });
      throw new Error("unreachable");
    };

    const r = await proposeForSubscription(makeSub(), {
      apiKey: "k",
      fetchImpl: fakeFetch,
      timeoutMs: 30,
      bypassCache: true,
    });
    assert.equal(r.ai.source, "fallback");
    assert.equal(r.ai.reason, "timeout");
  });

  it("HTTP 429 → fallback", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
      });

    const r = await proposeForSubscription(makeSub(), {
      apiKey: "k",
      fetchImpl: fakeFetch,
      bypassCache: true,
    });
    assert.equal(r.ai.source, "fallback");
    assert.equal(r.ai.reason, "http_429");
  });

  it("invented action write_off → fallback via zod", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify(
          geminiOkBody({
            action: "write_off",
            rationale: "Forgive the whole balance for goodwill retention.",
            customerMessage: "We have written off your outstanding balance.",
          })
        ),
        { status: 200 }
      );

    const r = await proposeForSubscription(makeSub(), {
      apiKey: "k",
      fetchImpl: fakeFetch,
      bypassCache: true,
    });
    assert.equal(r.ai.source, "fallback");
    assert.equal(r.ai.reason, "zod_fail");
  });

  it("policy reject (capture with $0 outstanding) → fallback", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify(
          geminiOkBody({
            action: "capture_outstanding",
            rationale: "Try to capture even though there is no balance left.",
            customerMessage: "Please pay the outstanding renewal amount soon.",
          })
        ),
        { status: 200 }
      );

    const r = await proposeForSubscription(
      makeSub({
        outstanding: money("0.00"),
        outstandingValue: 0,
        fixtureLabeled: true,
      }),
      {
        apiKey: "k",
        fetchImpl: fakeFetch,
        bypassCache: true,
      }
    );
    assert.equal(r.ai.source, "fallback");
    assert.match(r.ai.reason || "", /^policy_reject:/);
    assert.equal(r.proposal.action, "retry_later");
  });

  it("model ID and amount are ignored; code sets them", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify(
          geminiOkBody({
            action: "revise_cheaper",
            rationale:
              "Offer a retention discount on the next billing cycle only.",
            customerMessage:
              "We can switch you to a lower plan if you approve the change.",
            subscriptionId: "I-FAKE",
            proposedPrice: { currency_code: "USD", value: "1.00" },
            impact: { currency_code: "USD", value: "1.00" },
          })
        ),
        { status: 200 }
      );

    const r = await proposeForSubscription(makeSub(), {
      apiKey: "k",
      fetchImpl: fakeFetch,
      bypassCache: true,
    });
    assert.equal(r.ai.source, "gemini");
    assert.equal(r.proposal.subscriptionId, "I-3HK9STH33F7F");
    assert.equal(r.proposal.action, "revise_cheaper");
    assert.equal(r.proposal.proposedPrice?.value, "3.50");
  });

  it("API key never appears in request URL", async () => {
    const urls: string[] = [];
    const secret = "super-secret-gemini-key-xyz";
    const fakeFetch: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify(
          geminiOkBody({
            action: "retry_later",
            rationale: "Wait for the next failed-renewal lifecycle signal.",
            customerMessage:
              "We will retry your renewal after the payment method is updated.",
          })
        ),
        { status: 200 }
      );
    };

    await proposeForSubscription(
      makeSub({ outstandingValue: 0, outstanding: money("0.00") }),
      { apiKey: secret, fetchImpl: fakeFetch, bypassCache: true }
    );

    assert.equal(urls.length, 1);
    assert.equal(urls[0].includes("key="), false);
    assert.equal(urls[0].includes(secret), false);
  });

  it("demoWriteOff / forceRevise never call fetch", async () => {
    let called = 0;
    const fakeFetch: typeof fetch = async () => {
      called += 1;
      return new Response("{}", { status: 500 });
    };

    await proposeForSubscription(makeSub(), {
      demoWriteOff: true,
      apiKey: "k",
      fetchImpl: fakeFetch,
    });
    await proposeForSubscription(makeSub(), {
      forceRevise: true,
      apiKey: "k",
      fetchImpl: fakeFetch,
    });
    assert.equal(called, 0);
  });
});
