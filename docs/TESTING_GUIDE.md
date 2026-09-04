# A-COS Testing Guide

Step-by-step cURL walkthrough covering: signing up a merchant, catalog
discovery, a successful agent purchase, a guardrail-gated (human-approval)
purchase, and the gracefully-handled price-drift mandate breach.

A-COS is multi-tenant: every merchant gets their own catalog, policy,
sessions and audit chain, reached through **two separate credential
types** (see the README's "Two credential types" section for the full
rationale). This guide gets both once in Step 0, then every later command
just reuses the `$API_KEY` / `$TOKEN` shell variables.

## 0. Setup, sign up, and get your credentials

```bash
npm install
cp .env.example .env
# Edit .env: set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET to your Razorpay
# Test Mode keys (https://dashboard.razorpay.com/app/keys), and set
# DATABASE_URL to a real Postgres instance (docker compose up -d postgres
# gives you one matching the .env.example default).
npm run db:push            # creates/updates tables from src/db/schema.ts
npm run build && npm start
# or, for auto-reload during development:
npm run dev
```

The server listens on `http://localhost:4000` by default (`PORT` in `.env`).

Create a merchant account. The response includes a Dashboard JWT (`token`)
and an **Agent API key** (`api_key`) — the API key is shown by the server
exactly once, right here, so capture it now:

```bash
SIGNUP=$(curl -s -X POST http://localhost:4000/auth/signup \
  -H 'content-type: application/json' \
  -d '{"name":"Demo Store","email":"demo@example.com","password":"password123"}')

echo "$SIGNUP" | jq

TOKEN=$(echo "$SIGNUP" | jq -r .token)          # Dashboard JWT -> Authorization: Bearer
API_KEY=$(echo "$SIGNUP" | jq -r .api_key)      # Agent API key -> x-api-key
```

On any later day, get a fresh `$TOKEN` by logging in instead (login does
**not** re-return the API key — that's only ever shown at signup or on a
deliberate rotation):

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"password123"}' | jq -r .token)
```

Every response below that creates or touches money also includes an
`audit_id`; fetch the full chain for any intent with:

```bash
curl -s http://localhost:4000/agent/v1/audit/<intent_id> -H "Authorization: Bearer $TOKEN" | jq
```

and verify the tamper-evident hash chain at any time with:

```bash
curl -s http://localhost:4000/agent/v1/audit/verify-chain -H "Authorization: Bearer $TOKEN" | jq
# {"valid": true}
```

---

## 1. Discover the catalog (Module 1) — agent API key

```bash
# Schema.org/Commerce JSON-LD
curl -s http://localhost:4000/agent/v1/catalog -H "x-api-key: $API_KEY" | jq

# OpenAPI v3 spec describing this catalog surface (public, no auth needed)
curl -s http://localhost:4000/agent/v1/catalog/openapi.json | jq

# Search
curl -s "http://localhost:4000/agent/v1/catalog/search?query=headphone" -H "x-api-key: $API_KEY" | jq

# Issue a short-lived quote (quote_valid_for_sec: 120)
curl -s http://localhost:4000/agent/v1/catalog/quote/SKU-HEADPHONE-700 -H "x-api-key: $API_KEY" | jq

# Live inventory check
curl -s http://localhost:4000/agent/v1/catalog/inventory/SKU-HEADPHONE-700 -H "x-api-key: $API_KEY" | jq
```

The same three operations (`search_catalog`, `get_product_quote`,
`check_inventory`) are exposed as MCP tools — `A_COS_API_KEY=$API_KEY npm run mcp`
starts the stdio MCP server bound to this one merchant's catalog.

---

## 2. A successful agent purchase — ACP protocol (Module 2) — agent API key

```bash
curl -s -X POST http://localhost:4000/agent/v1/checkout \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "protocol": "acp",
    "checkout_session_id": "cs_demo_001",
    "buyer_agent": {
      "agent_id": "agent-001",
      "agent_name": "ShoppingBot",
      "agent_platform": "acp-runtime",
      "on_behalf_of_user_id": "user-42"
    },
    "line_items": [
      { "sku": "SKU-CABLE-99", "quantity": 1, "quoted_unit_price_inr": 99 }
    ],
    "currency": "INR",
    "pre_authorized_limit_inr": 500
  }' | jq
```

Expect `201` with `status: "SETTLED"` (or, without real Razorpay Test
Mode keys configured, a clean `502 REJECTED` naming the missing env
vars — every guardrail/audit step above it still ran for real; only the
last-hop Razorpay call fails), plus the full `audit_trail`
(INTENT_RECEIVED → PROTOCOL_TRANSLATED → POLICY_CHECK → SETTLEMENT). The
literal ACP route name is also mounted directly: `POST /checkout/create`
behaves identically and forwards your `x-api-key` through.

**A cart above the auto-approve limit (₹1,500 default) but within the
mandate** returns `202 PENDING_HUMAN_APPROVAL` instead of settling —
try it with `SKU-SPEAKER-2499` (₹2,499) and `pre_authorized_limit_inr: 5000`.
Resolve it from the dashboard side (JWT, not API key):

```bash
APPROVAL_ID=$(curl -s http://localhost:4000/agent/v1/approvals -H "Authorization: Bearer $TOKEN" | jq -r '.approvals[0].id')
curl -s -X POST http://localhost:4000/agent/v1/approvals/resolve \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"approval_id\":\"$APPROVAL_ID\",\"action\":\"approve\"}" | jq
```

---

## 3. AP2 protocol — signed mandate (Module 2) — agent API key

AP2 mandates must carry a valid HMAC-SHA256 signature over the canonical
mandate payload (production would verify a real JWS; this build uses a
shared-secret HMAC so the check is real and independently reproducible).
Compute it with the same secret configured in `.env`
(`A_COS_MANDATE_SIGNING_SECRET`):

```bash
node -e '
const crypto = require("crypto");
const secret = process.env.A_COS_MANDATE_SIGNING_SECRET || "change-me-in-production";
const mandate = {
  mandate_type: "cart_mandate",
  mandate_id: "mandate_001",
  issued_at: "2026-09-03T10:00:00.000Z",
  expires_at: "2026-09-03T11:00:00.000Z",
  max_amount_inr: 500,
  merchant_id: "merchant_example_001",
  user_id: "user-42"
};
console.log(crypto.createHmac("sha256", secret).update(JSON.stringify(mandate)).digest("hex"));
'
```

Use the printed signature as `signed_token`:

```bash
curl -s -X POST http://localhost:4000/agent/v1/checkout \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "protocol": "ap2",
    "buyer_agent": {
      "agent_id": "agent-ap2-001",
      "agent_name": "GoogleAgent",
      "agent_platform": "google-ap2-agent",
      "on_behalf_of_user_id": "user-42"
    },
    "line_items": [
      { "sku": "SKU-CABLE-99", "quantity": 1, "quoted_unit_price_inr": 99 }
    ],
    "currency": "INR",
    "mandate": {
      "mandate_type": "cart_mandate",
      "mandate_id": "mandate_001",
      "issued_at": "2026-09-03T10:00:00.000Z",
      "expires_at": "2026-09-03T11:00:00.000Z",
      "max_amount_inr": 500,
      "merchant_id": "merchant_example_001",
      "user_id": "user-42"
    },
    "signed_token": "<PASTE_SIGNATURE_HERE>"
  }' | jq
```

Tamper with a single character of `signed_token` and re-send — expect
`401` with `"AP2 mandate signature verification failed"`, and an
audited `MANDATE_VERIFICATION / FAIL` entry.

---

## 4. Upsell/cross-sell + negotiation (Module 3) — agent API key

```bash
# Bundle recommendations for a cart
curl -s -X POST http://localhost:4000/agent/v1/cart/recommendations \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"cart_skus": ["SKU-HEADPHONE-700"]}' | jq

# Counter-offer within the merchant's margin guardrail -> ACCEPTED
curl -s -X POST http://localhost:4000/agent/v1/negotiate \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"intent_id":"intent_demo_neg1","sku":"SKU-HEADPHONE-700","requested_discount_pct":8}' | jq

# Counter-offer beyond the guardrail -> COUNTERED at the max allowable %
curl -s -X POST http://localhost:4000/agent/v1/negotiate \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"intent_id":"intent_demo_neg2","sku":"SKU-HEADPHONE-700","requested_discount_pct":25}' | jq
```

---

## 5. The gracefully-handled failure — Price Drift / Mandate Breach (Module 4) — agent API key

This is the required scenario verbatim: quote at ₹700/unit, price drifts
to ₹790 mid-transaction, 2 units pushes the cart to ₹1,580 — over the
₹1,500 pre-authorized limit.

```bash
curl -s -X POST http://localhost:4000/agent/v1/checkout/simulate-failure \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{}' \
  -w '\nHTTP_STATUS:%{http_code}\n'
```

Expect:

```json
{
  "error": "MANDATE_BREACH",
  "intent_id": "intent_sim_...",
  "reason": "Price drift pushed cart total to ₹1580, exceeding the ₹1500 pre-authorized limit by ₹80.",
  "authorized_limit_inr": 1500,
  "attempted_total_inr": 1580,
  "drift_inr": 80,
  "reserved_funds_released": true,
  "recovery_choices": ["ADJUST_QUANTITY", "REQUEST_HUMAN_APPROVAL"],
  "audit_id": "..."
}
HTTP_STATUS:422
```

Pull the full trail for that `intent_id` (dashboard JWT, not API key —
audit reads are a merchant-management action) to see every step —
including the atomic fund release — recorded and hash-chained:

```bash
curl -s http://localhost:4000/agent/v1/audit/<intent_id> -H "Authorization: Bearer $TOKEN" | jq
```

You can also drive other drift amounts/quantities:

```bash
curl -s -X POST http://localhost:4000/agent/v1/checkout/simulate-failure \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"sku":"SKU-HEADPHONE-700","quantity":1,"authorized_limit_inr":1500,"drift_to_unit_price_inr":790}'
# 1 x ₹790 = ₹790, within ₹1,500 -> settles with no breach (status: SETTLED_NO_BREACH)
```

---

## 6. Inspect the full audit log — dashboard JWT

```bash
curl -s http://localhost:4000/agent/v1/audit -H "Authorization: Bearer $TOKEN" | jq
curl -s http://localhost:4000/agent/v1/audit/verify-chain -H "Authorization: Bearer $TOKEN" | jq
```

Every entry is append-only (`audit_log_entries` in Postgres, one
independent hash chain per merchant) and hash-chained — editing any
historical row breaks `verify-chain` for that tenant only.

---

## 7. Run the full Test Lab suite

14 scripted scenarios (happy-path, failure-path, and authorization-surface
cases) run for real against your merchant's own tenant data — not canned
output:

```bash
curl -s -X POST http://localhost:4000/agent/v1/test-lab/run -H "Authorization: Bearer $TOKEN" | jq '.results | map({id, passed, skipped, name})'
```

The one scenario that legitimately shows `"skipped": true` in a fresh
environment is the Razorpay order-creation step, until you configure real
`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` test-mode keys — everything
above that step (guardrails, policy, velocity, idempotency) is exercised
regardless.

---

## 8. Two merchants never see each other's data

```bash
TOKEN_B=$(curl -s -X POST http://localhost:4000/auth/signup \
  -H 'content-type: application/json' \
  -d '{"name":"Second Store","email":"second@example.com","password":"password123"}' | jq -r .token)

# Merchant A's sessions, using merchant B's token -> empty, never A's data
curl -s http://localhost:4000/agent/v1/sessions -H "Authorization: Bearer $TOKEN_B" | jq

# Fetching merchant A's specific checkout_session_id with B's token -> 404, not A's data
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:4000/agent/v1/sessions/cs_demo_001 -H "Authorization: Bearer $TOKEN_B"
```
