# Renewal Rescue

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Demo](https://img.shields.io/badge/Demo-Vercel-black.svg)](https://renewal-rescue.vercel.app)
[![PayPal](https://img.shields.io/badge/PayPal-Sandbox-0070BA.svg)](https://developer.paypal.com/)
[![Gemini](https://img.shields.io/badge/AI-Google%20Gemini-4285F4.svg)](https://ai.google.dev/)

A merchant recovery desk for **involuntary** PayPal subscription payment failures. When a billing charge fails and the subscription is suspended with an outstanding balance, Gemini proposes a capture or revise; deterministic policy gates it; a human merchant Approves. Live money moves only on Approve.

**Live demo:** [https://renewal-rescue.vercel.app](https://renewal-rescue.vercel.app)

> Built for the PayPal Agent Hackathon — sandbox demo with real PayPal Billing captures (not Simulator-only).

## How it works

1. **Refresh** loads seeded sandbox subscriptions from PayPal Billing (customer-style labels on the desk).
2. **Propose** asks Gemini for a recovery action + customer draft. Amounts and IDs are enforced in code. On timeout / schema / policy fail, a deterministic **Fallback** proposal is returned (never mislabeled as Gemini).
3. **Approve / Deny** require a deployment demo passcode (ask the team — do not invent one). Wrong passcode → no PayPal money call.
4. **Capture** uses `PayPal-Request-Id` = proposal token id (idempotent to re-Approve while settling). **Revise** has no PayPal idempotency key (retention / next-cycle price — not recovered cash).
5. Async captures (HTTP 202) show **Pending PayPal confirmation**; Refresh settles when outstanding hits `$0` and a verified COMPLETED txn ≥ $5 appears on the board.

**Never** treat Webhooks Simulator as money proof. Rows with no outstanding and no verified ≥ $5 COMPLETED recovery are labeled fixture and hidden by default.

Sandbox outstanding seeds use a **drained-funding recurring charge failure** on a setup-fee plan (same capture mechanism as a failed renewal). Do not claim the demo proves a natural calendar renewal failure unless you have that evidence.

## Try the demo

1. Open [https://renewal-rescue.vercel.app](https://renewal-rescue.vercel.app).
2. Click **Refresh** — live outstanding shells appear.
3. Select a row → **Propose** (Gemini badge + customer draft when the AI path succeeds).
4. Optional: **Deny demo** (write-off) → blocked by policy.
5. **Approve** one spare capture; leave others for the next visitor.
6. Prefer **Brightline Studio** if still outstanding — **Cedar Fitness** was already used for the filmed recovery path.

## Stack

| Layer | Choice |
| --- | --- |
| App | Next.js (App Router) + TypeScript |
| AI | Google Gemini (`generateContent` JSON propose) |
| Payments | PayPal REST sandbox (Billing subscriptions, outstanding capture, webhooks) |
| Policy | Deterministic in-process engine (ban write-off; capture/revise bounds) |
| Hosting | Vercel |

## Local setup

```bash
git clone https://github.com/prabhakaran-jm/renewal-rescue.git
cd renewal-rescue
cp .env.example .env   # PayPal sandbox + GEMINI_* + demo passcode + PROPOSAL_SIGNING_SECRET
npm install
npm run dev            # http://localhost:3000
npm test
npm run build
```

Money-safe smoke (checks passcode gate without moving money):

```bash
npm run smoke:money-safe
```

Seed / outstanding helpers: [`scripts/seed/README.md`](./scripts/seed/README.md).

```bash
npm run seed:all
npm run check:daily
```

## Failure → recovery

| Failure | Desk behaviour | Recovery |
| --- | --- | --- |
| Billing charge fails; subscription **SUSPENDED** with outstanding &gt; 0 | Propose suggests `capture_outstanding` (or revise) | Merchant Approve → PayPal outstanding-balance capture |
| Capture accepted async (HTTP 202) | Amber pending; desk polls outstanding | Outstanding `$0` + verified COMPLETED ≥ $5 → board update; activate may still be pending |
| Merchant wants retention instead of cash now | **Revise** → cheaper plan | Buyer approve URL for next-cycle price — **not** recovered cash |
| Write-off / 100% forgive | **Deny demo** propose path | Policy blocks; no capture |
| AI timeout / 429 / schema / policy fail | Deterministic proposal still returned | Badge shows **Fallback** |

## Verified balance recovery

Per subscription, the **first** live transaction with status **COMPLETED** and USD gross **≥ $5** (excludes `$1` setup fee). Recomputed each Refresh from the PayPal txn list — survives cold starts and async captures. Optimistic Approve rows are **Recovery pending** until the txn list confirms.

## Policy (deterministic)

- Ban write-off / 100% forgive
- Capture only if outstanding &gt; 0; amount ≤ outstanding; amount ≥ 50% of outstanding
- Revise discount ≤ 30%; next-cycle **retention**, not recovered cash

## AI tools disclosure

| Tool | Role |
| --- | --- |
| **Google Gemini** | In-product propose; amounts/IDs enforced in code; Fallback on failure |
| **Cursor / coding assistants** | Scaffold, implement, and test the desk |

## License

[MIT](./LICENSE)
