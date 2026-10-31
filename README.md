# Renewal Rescue

Recover **involuntary** MRR when a PayPal subscription renewal fails — capture outstanding or revise cheaper (retention), with AI propose + policy + human Approve.

**Never** treat Webhooks Simulator as money proof. Fixture rows with `$0` outstanding are labeled **FIXTURE**.

## Prerequisites

1. Sandbox business + personal accounts; app Client ID/Secret in `.env` (see `.env.example`).
2. Oct 30 seed complete — `fixtures/seed-ids.json` with 4 subscription ids.
3. Node 20+.

## Recovery desk (Step 5)

```bash
npm install
npm run dev
# → http://localhost:3000
```

Desk behavior:

| Step | What |
| --- | --- |
| Refresh | Lists 4 seeded subs via live `GET /v1/billing/subscriptions/{id}` |
| Propose | Deterministic schema `{capture_outstanding \| revise_cheaper \| retry_later \| escalate}` + policy gate |
| FIXTURE | When outstanding is `$0` — diagnosis only, not verified recovery |
| Preferred capture | `I-J8R13K0F76X4` (`setup-fee-continue`) — SUSPENDED + outstanding when present |
| Approve | Re-checks policy; **capture only if outstanding > 0**; revise returns **buyer approve URL** (retention / next cycle) |
| Deny / write-off demo | Policy refuses write-offs |

**Do not auto-capture.** Money APIs run only after merchant Approve. Film live capture in **Step 6** — for Step 5 validation use Refresh + Propose only.

### API sketch

- `GET /api/subscriptions` — seed ids + live PayPal refresh
- `POST /api/proposals` — body `{ subscriptionId?, demoWriteOff?, forceRevise? }`
- `POST /api/proposals/:id/approve` — capture / revise / no-op
- `POST /api/proposals/:id/deny`

### Validate (no live capture)

```bash
npm run test:policy
npm run build
npm run check:daily
# With `npm run dev` running:
curl -s http://localhost:3000/api/subscriptions
curl -s -X POST http://localhost:3000/api/proposals -H "content-type: application/json" -d "{\"subscriptionId\":\"I-J8R13K0F76X4\"}"
```

## Seed scripts (Oct 30 SET UP)

See [`scripts/seed/README.md`](./scripts/seed/README.md).

```bash
npm run seed:all
npm run check:daily
npm run webhook:dev
```

## Policy (deterministic)

- Ban write-off / 100% forgive
- Capture only if outstanding &gt; 0; amount ≤ outstanding; amount ≥ `minCapturePct` (50%) of outstanding
- Revise discount ≤ `maxDiscountPct` (30%); next-cycle **retention**, not recovered cash

## License

OSS — add `LICENSE` before Devpost submit.
