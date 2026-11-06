# Renewal Rescue

Recover **involuntary** subscription payments when a PayPal billing charge fails — AI proposes a capture or revise, policy gates it, and a human merchant Approves. Live money moves only on Approve.

**Demo:** [https://renewal-rescue.vercel.app](https://renewal-rescue.vercel.app)

**Never** treat Webhooks Simulator as money proof. Fixture rows (no outstanding and no verified ≥ $5 COMPLETED recovery) are labeled fixture and hidden on the desk by default.

Sandbox outstanding seeds use a **drained-funding recurring charge failure** on a setup-fee plan (same capture mechanism as a failed renewal). Do not claim the demo proves a natural calendar renewal failure unless you have that evidence.

## Judge setup (sandbox)

1. Open [https://renewal-rescue.vercel.app](https://renewal-rescue.vercel.app).
2. Click **Refresh** — live outstanding shells appear (customer-style labels).
3. Select a row → **Propose** (Gemini badge + customer draft when AI path succeeds; Fallback / RULE otherwise).
4. Optional: **Deny demo** (write-off) → blocked by policy; badge shows `RULE · write-off test`.
5. **Approve / Deny** require the demo passcode (`DEMO_PASSCODE` on the deployment). Ask the team for the judge passcode — do not invent one.
6. **Approve one spare; leave others** for the next judge.

Local:

```bash
cp .env.example .env   # fill PayPal + GEMINI_* + DEMO_PASSCODE + PROPOSAL_SIGNING_SECRET
npm install
npm run dev            # http://localhost:3000
npm test
npm run build
```

## Failure → Behaviour → Recovery

| Failure | Desk behaviour | Recovery |
| --- | --- | --- |
| Billing charge fails; subscription **SUSPENDED** with outstanding &gt; 0 | Refresh shows live outstanding; Propose suggests `capture_outstanding` (or revise). Gemini `retry_later` on SUSPENDED keeps the action but shows a RULE warning (PayPal will not auto-retry) and hides the customer draft | Merchant Approve → PayPal outstanding-balance capture (`PayPal-Request-Id` = proposal token id) |
| Capture accepted async (HTTP 202) | Amber **Pending PayPal confirmation**; desk polls outstanding (~5s, bounded) | When outstanding hits `$0`, settle → balance recovered, POST activate + **GET verify**; ACTIVE → subscription restored, else reactivation pending. Board shows Recovery pending until live txn confirms |
| Merchant wants retention instead of cash now | **Revise** → cheaper plan proposal | Buyer approve URL for next-cycle price; **not** recovered cash |
| Write-off / 100% forgive demo | **Deny demo** propose path | Policy blocks; no capture; Capture now hidden while blocked |
| AI timeout / 429 / malformed / policy fail | Propose still returns a deterministic proposal | Badge shows **Fallback** (never mislabeled as Gemini) |

## Idempotency

- **Capture:** `PayPal-Request-Id` is the proposal token short id — safe to re-Approve while settling CAPTURE_PEND / CAPTURE_IN_PROGRESS.
- **Revise:** **no** PayPal idempotency key. Re-Approve may create another revise / buyer-approve link. Treat revise as non-idempotent.

## DEMO_PASSCODE (testing)

Approve and Deny require `DEMO_PASSCODE` (compared with `timingSafeEqual`). Wrong passcode → **401**, no PayPal money call. Money-safe smoke:

```bash
npm run smoke:money-safe
```

Never commit the real passcode. Never log it.

## Verified balance recovery

Board rule (probe-informed): per subscription, the **first** live transaction with status **COMPLETED** and USD gross **≥ $5** (excludes `$1` setup fee). Recomputed each Refresh from the PayPal txn list — no in-memory allowlist (survives cold starts and async NO_CONTENT captures). This undercounts double recoveries on the same sub. Optimistic Approve / `desk_approve` rows are labeled **Recovery pending** and **excluded** from the verified total until the txn list confirms. Live $16 ledger: `7RG29592AA729850V` + `57J03146YN2648933` + `8W0050137N871594H`.

Always-probed history ids (even if env seed list is trimmed): `I-J8R13K0F76X4` (money proof), `I-CNCX69GD2UD8` (cleared film), `I-3FSFGWWRAV4D` (smoke).

## API sketch

- `GET /api/subscriptions` — seed ids + live PayPal refresh
- `POST /api/proposals` — `{ subscriptionId?, demoWriteOff?, forceRevise?, forceCapture? }`
- `POST /api/proposals/:id/approve` — passcode → capture / revise / settle
- `POST /api/proposals/:id/deny`
- `GET /api/recovered-mrr` — verified balance recovery board
- `POST /api/webhooks/paypal` — signature verify + inbox
- `GET /api/webhooks/inbox`

## Policy (deterministic)

- Ban write-off / 100% forgive
- Capture only if outstanding &gt; 0; amount ≤ outstanding; amount ≥ `minCapturePct` (50%) of outstanding
- Revise discount ≤ `maxDiscountPct` (30%); next-cycle **retention**, not recovered cash

## AI tools disclosure (DevPost)

| Tool | Role |
| --- | --- |
| **Google Gemini** | In-product propose (`generateContent` JSON); amounts/IDs enforced in code; Fallback when timeout/error/schema/policy fail |
| **Cursor / coding assistants** | Used to scaffold, implement, and test the desk |

## Seed scripts

See [`scripts/seed/README.md`](./scripts/seed/README.md).

```bash
npm run seed:all
npm run check:daily
```

## License

[MIT](./LICENSE)
