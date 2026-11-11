# Sandbox seed scripts

Create PayPal sandbox catalog, daily plans, and subscription shells for the recovery desk.

**Never** treat Webhooks Simulator as money proof. Prefer shells with real Billing `outstanding_balance > 0` (SUSPENDED after a failed setup-fee charge on a drained buyer).

## Prerequisites

1. Same-country sandbox **business** (merchant) + **personal** (buyer) accounts.
2. Sandbox app credentials; enable **Transaction Search** on the app if available.
3. Copy `.env.example` → `.env` (or `.env.local`) and fill:

| Var | Required | Purpose |
| --- | --- | --- |
| `PAYPAL_CLIENT_ID` | yes | Sandbox app client id |
| `PAYPAL_CLIENT_SECRET` | yes | Sandbox app secret (never commit / never log) |
| `PAYPAL_API_BASE` | yes | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_WEBHOOK_ID` | for listener | Dashboard webhook id after URL registered |
| `WEBHOOK_PUBLIC_URL` | for listener | Public tunnel to `localhost:8787` |
| `PAYPAL_PRODUCT_ID` | optional | Reuse existing catalog product |

## Commands

```bash
# Full API portion (catalog → daily plans → subscription shells)
npm run seed:all

# Or stepwise
npm run seed:catalog
npm run seed:plans
npm run seed:subs

# After buyers approve in browser
node scripts/seed/seed-subscriptions.mjs --refresh

# Snapshot outstanding / status for listed shells
npm run check:daily

# Signature-verifying webhook listener (tunnel required)
npm run webhook:dev
```

Ids land in `fixtures/seed-ids.json` (gitignored). Copy shape from `fixtures/seed-ids.template.json`.

## Failure paths (manual buyer steps)

| Key | Plan | Buyer action |
| --- | --- | --- |
| `drained-balance` | standard (DAY $5, threshold 1) | Approve with buyer that has empty/insufficient balance + declining card |
| `card-removed` | standard | Approve, then remove funding instrument in sandbox wallet |
| `setup-fee-continue` | setupFee (setup_fee $1 + CONTINUE + auto_bill_outstanding + threshold 1) | Money-proof history `I-J8R13K0F76X4` — keep listed; do not re-use for judge capture |
| `drained-balance-2` | standard | Optional extra drained path |
| `judge-demo-outstanding` | setupFee (same plan) | Drain → approve (setup fee fails) → SUSPENDED+outstanding → restore funding; **do not capture** until demo |

```bash
# Create only the judge-demo shell (keeps existing ids)
node scripts/seed/seed-subscriptions.mjs --demo-outstanding
```

### Outstanding batch (setupFee shells)

```bash
npm run seed:outstanding-batch
# or force-replace stale APPROVAL_PENDING shells:
node scripts/seed/seed-subscriptions.mjs --outstanding-batch --force
```

Keys: `outstanding-smoke`, `outstanding-film`, `outstanding-judge-1`…`outstanding-judge-4`.

**Interactive (required for SUSPENDED + ~$5 outstanding):**

1. **Drain first** (before opening any BA link): sandbox **Personal** buyer balance ~$0; remove working cards. Optional: add only declining test card `4556747948786484` (CCREJECT).
2. Open each approve URL → Agree & Subscribe.
3. Expect **SUSPENDED + outstanding ≈ $5** (setup fee fails → CONTINUE). Approving while funded → ACTIVE / $0–$1 (wrong outcome — re-run `--outstanding-batch --force`).
4. Restore funding without capturing → `--refresh` + `npm run check:daily`.
5. Before deploying seed ids: PayPal outstanding ≥ $5 **and** no prior COMPLETED USD ≥ $5 (first-$5 attribution). Then set `SEED_SUBSCRIPTION_IDS`. Budget: smoke ≤1, film ≤1, leave judge shells for visitors.

Also set a demo passcode for Approve/Deny (`timingSafeEqual`; never commit/log the value).

## Judge spare note

**Brightline Studio** (`outstanding-judge-1` / historically `I-S5J71BPHJBT3`) should remain the prefer-to-leave spare after **Cedar Fitness** was used for the filmed recovery. Confirm live status with Refresh before approving.
