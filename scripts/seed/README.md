# Oct 30 SET UP — sandbox seed scripts

**Mode:** SET UP only. **Nov 3** decides go/no-go on real `outstanding_balance > 0`.  
**Never** treat Webhooks Simulator as money proof.

## Prerequisites

1. Same-country sandbox **business** (merchant) + **personal** (buyer) accounts.
2. Sandbox app credentials; enable **Transaction Search** on the app if available.
3. Copy `.env.example` → `.env.local` and fill:

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
# Full API portion (catalog → daily plans → 4 subscription shells)
npm run seed:all

# Or stepwise
npm run seed:catalog
npm run seed:plans
npm run seed:subs

# After buyers approve in browser
node scripts/seed/seed-subscriptions.mjs --refresh

# Daily through Nov 3
npm run check:daily

# Signature-verifying webhook listener (tunnel required)
npm run webhook:dev
```

Ids land in `fixtures/seed-ids.json` (gitignored pattern recommended once secrets-adjacent). Daily snapshots: `fixtures/daily-checks/YYYY-MM-DD.json`.

## Failure paths (manual buyer steps)

| Key | Plan | Buyer action |
| --- | --- | --- |
| `drained-balance` | standard (DAY $5, threshold 1) | Approve with buyer that has empty/insufficient balance + declining card |
| `card-removed` | standard | Approve, then remove funding instrument in sandbox wallet |
| `setup-fee-continue` | setupFee (setup_fee $1 + CONTINUE + auto_bill_outstanding + threshold 1) | **Money-proof history** `I-J8R13K0F76X4` — keep listed; do not re-use for judge capture |
| `drained-balance-2` | standard | Optional 4th drained path |
| `judge-demo-outstanding` | setupFee (same plan) | Step 7: drain → approve (setup fee fails) → SUSPENDED+outstanding → restore funding; **do not capture** until demo |

```bash
# Create only the judge-demo shell (keeps existing ids)
node scripts/seed/seed-subscriptions.mjs --demo-outstanding
```

## Nov 3 rule

Any seeded sub with real **`outstanding_balance > 0`** (Billing GET, not Simulator) → build Renewal Rescue. Else → cancel-save / plan-revision desk.
