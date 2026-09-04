# Razorpay Agentic Commerce OS (A-COS)

A multi-tenant SaaS platform that turns any merchant into an
AI-transactable store: agent-readable catalog, multi-protocol checkout
(ACP / Google AP2 / x402 / NPCI UAP) settling through Razorpay Test Mode,
an upsell/negotiation + campaign engine, and a per-merchant immutable,
hash-chained audit + guardrail gate. Merchants self-signup, get their own
isolated catalog/policy/audit chain, and manage everything from a
dashboard — no code, no config file editing.

## Two credential types

Every route needs one of two different credentials, matching who's
calling:

| Credential | Header | Who uses it | Issued |
|---|---|---|---|
| **Agent API key** | `x-api-key` | An AI shopping agent calling the storefront surface: catalog, checkout, cart recommendations, negotiation | Shown once, at signup or on a deliberate rotation (`POST /auth/rotate-key`) — never re-derivable after that |
| **Dashboard JWT** | `Authorization: Bearer` | The merchant managing their own store: sessions, approvals, refunds, policy, campaigns, audit, Test Lab | Returned by `POST /auth/signup` / `POST /auth/login`, 7-day expiry by default |

This split exists because the two callers have fundamentally different
trust levels and lifetimes — an agent integration runs unattended for
months, a merchant dashboard session is a human logging in. Losing one
credential should never expose the other's capabilities.

## Architecture

```
                                    ┌─────────────────────────────────┐
  Merchant (browser)  ──JWT────────▶│                                  │
                                    │        A-COS (Fastify)           │      Razorpay
  AI buyer agent      ──API key────▶│                                  │    Test Mode API
 (ACP/AP2/x402/UAP)                 │  ┌────────────────────────────┐  │          │
                                    │  │ Module 1: Catalog + MCP     │  │          │
                                    │  └────────────────────────────┘  │          │
                                    │  ┌────────────────────────────┐  │          │
                                    │  │ Module 2: Protocol Bridge   │──┼──Orders──▶
                                    │  │ (adapts each protocol to a  │  │  API     │
                                    │  │  normalized Intent)         │  │          │
                                    │  └─────────────┬──────────────┘  │          │
                                    │                ▼                 │          │
                                    │  ┌────────────────────────────┐  │          │
                                    │  │ Module 4: Guardrail Gate    │  │          │
                                    │  │ (spend cap, MCC, sig        │  │          │
                                    │  │  verify, per-tenant audit)  │  │          │
                                    │  └─────────────┬──────────────┘  │          │
                                    │                ▼                 │          │
                                    │  ┌────────────────────────────┐  │          │
                                    │  │ Module 3: Upsell/Negotiate  │  │          │
                                    │  │  + Campaign Orchestrator    │  │          │
                                    │  └────────────────────────────┘  │          │
                                    └───────────────┬───────────────────┘          │
                                                     ▼
                                          Postgres (Drizzle ORM)
                                every table carries merchant_id; every
                                query is scoped by it — see "Multi-tenancy"
```

## Modules → files

| # | Module | File(s) |
|---|--------|---------|
| — | Auth (signup/login, JWT, API keys) | `src/services/auth.ts`, `src/middleware/auth.ts` |
| 1 | Agent-readable catalog + MCP server | `src/services/mcp_catalog.ts`, `src/services/catalog.ts`, `src/mcp/server.ts` |
| 2 | Conversational checkout / protocol bridge | `src/services/protocol_bridge.ts`, `src/services/razorpay_client.ts` |
| 3 | Upsell/cross-sell agent (growth engine) | `src/services/growth.ts` |
| 3b | Campaign orchestrator | `src/services/campaigns.ts` |
| — | Negotiation (bundle suggestion at checkout time) | `src/services/negotiation.ts` |
| 4 | Audit engine + guardrail gate | `src/middleware/guardrail_gate.ts`, `src/services/audit_log.ts` |
| — | Persistence (Postgres via Drizzle) | `src/db/*.ts` (one repository file per domain), `src/db/schema.ts` |
| — | Shared types | `src/schema/types.ts` (Zod models for ACP/AP2/x402/NPCI-UAP/Audit) |
| — | Server / routing | `src/server.ts` |
| — | Dashboard frontend (single-file SPA) | `a-cos-app.html` |

## Quick start

### Option A — Docker (recommended: gets you Postgres + migrations + the app in one command)

```bash
cp .env.example .env    # fill in RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET and JWT_SECRET at minimum
docker compose up --build
# App: http://localhost:4000   Postgres: localhost:5432
```

`docker compose` runs three services: `postgres`, a one-shot `migrate`
step that pushes `src/db/schema.ts` onto it, then `app`. Re-run schema
changes any time with `docker compose run --rm migrate`.

### Option B — local Node + local/external Postgres

```bash
npm install
cp .env.example .env
# Point DATABASE_URL at a real Postgres (docker compose up -d postgres
# gives you one matching the .env.example default), and fill in your
# Razorpay Test Mode keys.
npm run db:push          # creates/updates tables from src/db/schema.ts
npm run build
npm start                # http://localhost:4000
```

Then open `a-cos-app.html` in a browser (or serve it statically) — it
defaults to `http://localhost:4000` as its API base and will prompt you
to sign up on first load.

Full walkthrough (signup, successful purchase, guardrail routing, the
required price-drift mandate-breach scenario, and multi-tenant
isolation): see **`docs/TESTING_GUIDE.md`**.

## Multi-tenancy

- Every domain table carries `merchant_id`, and every service function
  takes `merchantId` as an explicit, required parameter — there is no
  code path that queries the database without it, with **one documented
  exception**: all merchants currently settle through a single shared
  Razorpay Test Mode account (see "Known limitations"), so the Razorpay
  webhook receiver resolves `merchantId` from the order/payment ID via
  one deliberate cross-tenant lookup (`findSessionByOrderOrPaymentGlobal`
  in `src/db/sessions.ts`) before continuing — the only place in the
  codebase that queries without a merchant scope already in hand.
- New signups are seeded with the same demo catalog and Policy v1
  defaults the original prototype hardcoded (`seedMerchantCatalog`,
  `seedMerchantPolicy` in `src/services/auth.ts`), so a fresh account is
  immediately usable, not empty.
- The per-merchant audit hash chain is serialized through an in-process
  async mutex (`src/utils/mutex.ts`) so two concurrent requests for the
  same merchant can never read the same "last hash" and fork the chain.
  This covers a **single backend instance**; horizontally scaling to
  multiple app instances would need a Postgres advisory lock
  (`pg_advisory_xact_lock`) instead — see "Known limitations".
- The Test Lab (`POST /agent/v1/test-lab/run`) runs its 14 scripted
  scenarios against the *calling* merchant's own real tenant data — a
  genuine self-service account health check, not a shared fixture.

## Security

- Passwords hashed with bcrypt (`BCRYPT_SALT_ROUNDS`, default 12).
- Agent API keys are SHA-256-hashed at rest (`acos_live_<48 hex chars>`)
  and shown in full exactly once.
- `@fastify/helmet` (security headers), `@fastify/rate-limit` (300
  req/min default, tighter 10/min on signup and 20/min on login —
  `RATE_LIMIT_MAX` to tune), `@fastify/cors` (`CORS_ORIGIN`, comma-
  separated allow-list; defaults to allow-all for ease of local dev —
  **set this in production**).
- Razorpay webhook events are only accepted with a verified
  HMAC-SHA256 signature against `RAZORPAY_WEBHOOK_SECRET`.

## Design notes

- **Every money action is explainable, bounded and gated.** No path in
  `protocol_bridge.ts` can reach `createRazorpayOrder()` without first
  passing `runGuardrailGate()`, and every step (intent, translation,
  mandate verification, policy check, negotiation, settlement, failure)
  writes an immutable, hash-chained entry via `audit_log.ts`. Tamper
  detection: `GET /agent/v1/audit/verify-chain` (per-merchant chain).
- **Bounded by design, not by convention.** Spend caps and MCC
  restrictions are enforced in one place (`evaluatePolicy`), and a cart
  over the auto-approve threshold is routed to `PENDING_HUMAN_APPROVAL`
  rather than silently settled.
- **One gracefully-handled failure**, as required: a price-drift /
  mandate-breach scenario (`POST /agent/v1/checkout/simulate-failure`)
  halts execution, atomically releases reserved funds, and returns
  `422` with machine-readable recovery choices
  (`ADJUST_QUANTITY`, `REQUEST_HUMAN_APPROVAL`).
- **Protocol-agnostic core.** All four protocols reduce to one
  `CheckoutIntent` shape before guardrails or settlement ever run, so
  adding a fifth protocol (e.g. a future NPCI UAP revision) means adding
  one adapter function, not touching settlement or audit logic.
- **Real Razorpay Test Mode**, not a stub — `src/services/razorpay_client.ts`
  calls the official `razorpay` npm SDK's Orders API. Without valid test
  keys configured, checkout intents pass through every guardrail/audit
  step correctly and fail cleanly at the last hop with a clear
  configuration error rather than crashing.
- **Real persistence.** All tenant data — catalog, quotes, policy
  history, sessions, approvals, refunds, payment links, webhook events,
  campaigns, the growth ledger, and the audit chain — lives in Postgres
  via Drizzle ORM (`src/db/*.ts`), not memory. Restarting the server
  loses nothing.

## What's mocked vs. real

| Piece | Status |
|---|---|
| Razorpay Orders API (test mode) | **Real** — actual SDK call, needs your test keys |
| Postgres persistence, bcrypt auth, JWT sessions, per-merchant API keys | **Real** |
| Multi-tenant isolation (cross-tenant 404s, scoped queries) | **Real** — verified live, see `docs/TESTING_GUIDE.md` §8 |
| ACP `/checkout/create` shape | Modeled from the public ACP spec |
| AP2 signed mandate | Real HMAC-SHA256 signature verification; production would verify a JWS against Google's published keys |
| x402 payment header | Real replay-nonce + amount-ceiling enforcement; no on-chain settlement (out of scope for INR/Razorpay rails) |
| NPCI UAP delegated authority | Mocked settlement bridge with real HMAC signature + expiry verification, standing in for NPCI's not-yet-public UAP signing scheme |
| Multi-tenant billing / plan tiers | `plan` field exists on the merchant record but nothing enforces limits by plan or collects payment for it — see "Known limitations" |

## Transaction lifecycle (v2)

Order creation and payment capture are tracked as two separate, independent
facts on a canonical `CheckoutSession` (`src/services/checkout_session.ts`):
`order_status` (`NONE → CREATED → PAID/CANCELLED`) and `payment_status`
(`NONE → INITIATED → AUTHORIZED → CAPTURED/FAILED → REFUNDED/PARTIALLY_REFUNDED`).
A Razorpay order being created (`ORDER_CREATED`) never implies payment was
captured — only a verified webhook (`src/services/webhooks.ts`) or an
explicitly-flagged simulated Test Lab event (`src/services/dev_tools.ts`,
`simulated_payment: true` forever after) can move `payment_status` forward.
Every state change goes through `transitionSession()`, which refuses any
transition not in its explicit state-machine table.

- **Policy v2** (`src/services/policy_store.ts`) — versioned, draft →
  publish per merchant, with real hourly/daily/monthly velocity limits and
  transaction/failed-attempt counters per agent, category and payment-
  method allow/block lists, and a per-item quantity ceiling.
  `GET/POST /agent/v1/policy*`.
- **Idempotency** (`src/services/idempotency.ts`) — an `Idempotency-Key`
  header on `/agent/v1/checkout` and `/agent/v1/refunds` guarantees a
  retried request returns the original result, never a duplicate order or
  refund.
- **Refunds** — real Razorpay Refunds API calls, refuses to refund a
  session that isn't genuinely `CAPTURED` and non-simulated.
  `POST /agent/v1/refunds`.
- **Payment Links** — real Razorpay Payment Links API, the recovery path
  when autonomous checkout can't complete. `POST /agent/v1/payment-links`.
- **Webhooks** — a real receiver with genuine HMAC-SHA256 signature
  verification against `RAZORPAY_WEBHOOK_SECRET`, idempotent event
  processing (duplicate/out-of-order safe). `POST /agent/v1/webhooks/razorpay`.
  Needs a public URL registered in the Razorpay Dashboard to receive real
  events — see "Known limitations".
- **Approvals** — real approve/reject/modify-authorization semantics; a
  modified limit is actually re-checked against the cart before an order
  is created. `GET /agent/v1/approvals`, `POST /agent/v1/approvals/resolve`.
- **Test Lab** (`src/services/test_lab.ts`) — 14 scripted scenarios that
  exercise this real code, per-merchant, in-process (not canned output).
  `POST /agent/v1/test-lab/run`.

## Upsell & cross-sell agent (growth engine)

`src/services/growth.ts` is the merchant-facing "Upsell & Cross-sell"
surface:

- Every recommendation is backed by a real per-merchant impression/
  acceptance ledger, not invented stats. An **impression** is recorded
  every time `/agent/v1/cart/recommendations` actually surfaces a
  companion SKU for a cart; an **acceptance** is recorded whenever a real
  checkout intent's cart ends up containing both the primary and
  companion SKU (`recordAcceptance`, called from `protocol_bridge.ts` for
  every checkout, and audited as a `RECOMMENDATION` step).
- Until at least 8 impressions exist for a pair, its acceptance rate is
  additive-smoothed toward a conservative catalog-margin baseline and
  labeled `ESTIMATED`; past that sample size it's labeled `LIVE` and
  converges on the real observed rate.
- Merchants can enable/disable any recommendation pair
  (`POST /agent/v1/growth/recommendations/toggle`); disabled pairs stop
  being surfaced to buyers immediately.
- Routes: `GET /agent/v1/growth/recommendations` (dashboard, all pairs),
  `GET /agent/v1/growth/opportunities`, `POST /agent/v1/growth/recommendations/toggle`.

## Campaign orchestrator

`src/services/campaigns.ts` + the `getOpportunities()` half of
`growth.ts` turn a detected upsell opportunity into a running,
policy-bound campaign, per merchant:

- **Revenue Opportunities** (`GET /agent/v1/growth/opportunities`)
  surfaces pairs with a ≥15% blended acceptance rate that don't already
  have an active campaign, each with a suggested campaign (name, trigger
  intent, discount, budget, daily order cap) pre-filled from real catalog
  prices.
- **The suggested discount is pre-cleared against the merchant's own
  published policy** so "Create bundle" doesn't bounce on its own
  suggestion — but creation still re-validates independently
  (`POST /agent/v1/campaigns`).
- Once **active**, a campaign is applied automatically inside
  `protocol_bridge.ts` at checkout time: if a cart contains a SKU with an
  active campaign and remaining budget, the discount is deducted from the
  cart total *before* the policy/guardrail check runs, an audited
  `CAMPAIGN_APPLIED` step is written, and — only after the Razorpay order
  is genuinely created — the campaign's `spent_inr` is incremented
  atomically (`recordCampaignRedemption`, single-statement SQL update, no
  read-modify-write race). A campaign that hits its budget or is paused
  stops applying immediately.
- Routes: `GET /agent/v1/campaigns`, `POST /agent/v1/campaigns`,
  `POST /agent/v1/campaigns/:id/activate`, `POST /agent/v1/campaigns/:id/pause`,
  `GET /agent/v1/campaigns/:id`.

## Docker & CI

- `Dockerfile` — multi-stage (`build` compiles TypeScript with full
  devDependencies; `runtime` is a slim `node:20-alpine` image running as
  a non-root user, with a container `HEALTHCHECK` against `/health`).
- `docker-compose.yml` — `postgres` (with a health check), a one-shot
  `migrate` service (runs `drizzle-kit push` using the `build` stage,
  then exits), and `app`. All configurable via a `.env` file next to
  the compose file.
- `.github/workflows/ci.yml` — on every push/PR to `main`: installs,
  type-checks, builds, spins up a real Postgres service container,
  pushes the schema, boots the server, then runs a real smoke test
  (signup → auth-boundary checks on both credential types → catalog
  access), the full 14-scenario Test Lab suite, and an audit-chain
  integrity check — all against the live server, not mocked.

## Known limitations

Disclosed honestly rather than glossed over — these are the real gaps
between this build and a fully hardened production SaaS:

- **One shared Razorpay Test Mode account, platform-wide.** All
  merchants currently settle through one `RAZORPAY_KEY_ID` /
  `RAZORPAY_KEY_SECRET` pair (a merchant-of-record model), which is why
  the webhook receiver needs its one documented cross-tenant lookup (see
  "Multi-tenancy"). Real production would give each merchant their own
  Razorpay Route / linked sub-account, which requires per-merchant KYC
  with Razorpay — a business process outside what this codebase can do.
- **Audit-chain mutex is single-instance-only.** `src/utils/mutex.ts`
  correctly serializes writes within one running Node process; running
  multiple app instances behind a load balancer would need a Postgres
  advisory lock (`pg_advisory_xact_lock`) to keep the same guarantee.
- **No Postgres row-level security (RLS) as defense-in-depth.** Tenant
  isolation is enforced entirely in the application layer (every query
  scoped by `merchantId`, verified live — see `docs/TESTING_GUIDE.md`
  §8). A second layer of RLS policies at the database level would catch
  a hypothetical application-layer bug that forgot to scope a query;
  it's not there yet.
- **Billing is a stub.** The `plan` field exists on the merchant record,
  but no plan limits are enforced and no real subscription billing is
  collected — building fake billing would have violated the "never
  fabricate" principle this project holds to, so it's simply absent
  rather than faked.
- **No live cloud deployment performed.** This has been built and
  verified locally (real Postgres, real signup/login/checkout flows,
  live two-merchant isolation testing, a full Playwright pass over the
  frontend auth flow) but not deployed to a public host. Doing so, and
  enabling real Razorpay live-mode keys (which requires the merchant's
  own KYC with Razorpay), are next steps for whoever operates this.
- **No real webhook can be delivered to a local dev environment** (no
  public URL) — the receiver's signature verification and event handling
  are real and tested with a synthetic signed event
  (`src/services/dev_tools.ts`), but end-to-end delivery from Razorpay
  itself requires deploying this backend somewhere reachable.
- **x402's `network` field is a placeholder string** — there's no real
  crypto-rail settlement since this bridge targets Razorpay/INR.
- **True A/B statistical-significance testing is not implemented** —
  the growth engine's `ESTIMATED` vs `LIVE` labeling is honest about
  sample size, but there's no formal significance test.
