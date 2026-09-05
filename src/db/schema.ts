/**
 * src/db/schema.ts
 *
 * A-COS multi-tenant schema (Drizzle ORM / Postgres).
 *
 * Every table that holds merchant data carries a `merchantId` and MUST be
 * queried scoped to it. This file is the single source of truth for the
 * database shape; `src/db/*.ts` repository modules are the ONLY code
 * allowed to import from `drizzle-orm/pg-core` operators directly — every
 * service above them goes through a repository function that takes
 * merchantId as an explicit, non-optional first argument.
 *
 * (Real production hardening beyond this pass: Postgres row-level security
 * as defense-in-depth against a repository-layer bug — see README "Known
 * limitations".)
 */

import {
  pgTable,
  text,
  doublePrecision,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Tenancy                                                             */
/* ------------------------------------------------------------------ */

export const merchants = pgTable("merchants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  /** SHA-256 hash of the live API key — the raw key is shown once, at issuance/rotation, and never stored. */
  apiKeyHash: text("api_key_hash").notNull().unique(),
  /** First 8 chars of the raw key, so the dashboard can show "acos_live_8f2a…" without storing the full key. */
  apiKeyPrefix: text("api_key_prefix").notNull(),
  plan: text("plan").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    mcc: text("mcc").notNull(),
    priceInr: doublePrecision("price_inr").notNull(),
    inventoryCount: integer("inventory_count").notNull(),
    marginPct: doublePrecision("margin_pct").notNull(),
    imageUrl: text("image_url").notNull(),
    driftEnabled: boolean("drift_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_merchant_sku_uq").on(t.merchantId, t.sku),
    index("products_merchant_idx").on(t.merchantId),
  ]
);

/**
 * A reservation hold placed against a product's stock the moment a
 * checkout session commits to buying it — NOT a permanent decrement of
 * `products.inventory_count`. Available quantity for a SKU is always
 * `inventory_count - SUM(quantity WHERE status='held')`, computed live
 * (see services/inventory.ts) rather than cached, so there is no counter
 * that can drift out of sync with reality.
 *
 * Lifecycle: held -> released (checkout blocked/rejected/cancelled/timed
 * out — stock goes back to the pool) OR held -> consumed (payment really
 * captured — inventory_count is permanently decremented and the hold is
 * closed out). `expiresAt` is the lock timestamp: the background sweep
 * in services/scheduler.ts releases any hold still `held` past this time,
 * so a checkout that's abandoned mid-flight can never hold stock hostage
 * forever.
 */
export const inventoryHolds = pgTable(
  "inventory_holds",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    checkoutSessionId: text("checkout_session_id").notNull(),
    sku: text("sku").notNull(),
    quantity: integer("quantity").notNull(),
    status: text("status").notNull(), // "held" | "released" | "consumed"
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: text("resolution_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("inventory_holds_merchant_sku_idx").on(t.merchantId, t.sku),
    index("inventory_holds_merchant_session_idx").on(t.merchantId, t.checkoutSessionId),
    index("inventory_holds_status_expiry_idx").on(t.status, t.expiresAt),
  ]
);

export const bundleRules = pgTable(
  "bundle_rules",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    primarySku: text("primary_sku").notNull(),
    companionSku: text("companion_sku").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [
    uniqueIndex("bundle_rules_uq").on(t.merchantId, t.primarySku, t.companionSku),
    index("bundle_rules_merchant_primary_idx").on(t.merchantId, t.primarySku),
  ]
);

export const quotes = pgTable(
  "quotes",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    sku: text("sku").notNull(),
    unitPriceInr: doublePrecision("unit_price_inr").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    validForSec: integer("valid_for_sec").notNull(),
  },
  (t) => [index("quotes_merchant_idx").on(t.merchantId)]
);

/* ------------------------------------------------------------------ */
/* Policy v2 + agent profiles + velocity                               */
/* ------------------------------------------------------------------ */

export const policies = pgTable(
  "policies",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(), // "draft" | "published"
    autoApproveLimitInr: doublePrecision("auto_approve_limit_inr").notNull(),
    velocity: jsonb("velocity").notNull(),
    allowedCategories: jsonb("allowed_categories").notNull(),
    blockedCategories: jsonb("blocked_categories").notNull(),
    maxQuantityPerItem: integer("max_quantity_per_item").notNull(),
    maxAutoDiscountPct: doublePrecision("max_auto_discount_pct").notNull(),
    maxAbsoluteDiscountInr: doublePrecision("max_absolute_discount_inr"),
    allowedPaymentMethods: jsonb("allowed_payment_methods").notNull(),
    blockedPaymentMethods: jsonb("blocked_payment_methods").notNull(),
    newCustomerLimitInr: doublePrecision("new_customer_limit_inr"),
    humanApprovalNewCategory: boolean("human_approval_new_category").notNull(),
    humanApprovalAddressChange: boolean("human_approval_address_change").notNull(),
    humanApprovalPaymentMethodChange: boolean("human_approval_payment_method_change").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("policies_merchant_version_uq").on(t.merchantId, t.version),
    index("policies_merchant_status_idx").on(t.merchantId, t.status),
  ]
);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    agentId: text("agent_id").notNull(),
    verified: boolean("verified").notNull().default(true),
    protocol: text("protocol").notNull(),
    perTransactionInr: doublePrecision("per_transaction_inr").notNull(),
    hourlyInr: doublePrecision("hourly_inr").notNull(),
    dailyInr: doublePrecision("daily_inr").notNull(),
    monthlyInr: doublePrecision("monthly_inr").notNull(),
    discountAuthorityPct: doublePrecision("discount_authority_pct").notNull(),
    maxQuantity: integer("max_quantity").notNull(),
    allowedCategories: jsonb("allowed_categories").notNull(),
    restrictedCategories: jsonb("restricted_categories").notNull(),
  },
  (t) => [uniqueIndex("agent_profiles_merchant_agent_uq").on(t.merchantId, t.agentId)]
);

export const velocityEvents = pgTable(
  "velocity_events",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    agentId: text("agent_id").notNull(),
    amountInr: doublePrecision("amount_inr").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    failed: boolean("failed").notNull(),
  },
  (t) => [index("velocity_events_merchant_agent_ts_idx").on(t.merchantId, t.agentId, t.ts)]
);

/* ------------------------------------------------------------------ */
/* Checkout / transactions                                             */
/* ------------------------------------------------------------------ */

export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: text("id").primaryKey(), // "cs_..."
    merchantId: text("merchant_id").notNull(),
    customerId: text("customer_id"),
    buyerAgentId: text("buyer_agent_id").notNull(),
    protocol: text("protocol").notNull(),
    intentId: text("intent_id").notNull(),
    cart: jsonb("cart").notNull(),
    quoteId: text("quote_id"),
    authorizationInr: doublePrecision("authorization_inr").notNull(),
    policyVersion: integer("policy_version").notNull(),
    policyDecision: text("policy_decision"),
    riskDecision: text("risk_decision").notNull().default("LOW"),
    shippingInr: doublePrecision("shipping_inr").notNull().default(0),
    taxInr: doublePrecision("tax_inr").notNull().default(0),
    discountInr: doublePrecision("discount_inr").notNull().default(0),
    finalAmountInr: doublePrecision("final_amount_inr").notNull(),
    currency: text("currency").notNull(),
    paymentMethod: text("payment_method"),
    razorpayOrderId: text("razorpay_order_id"),
    razorpayPaymentId: text("razorpay_payment_id"),
    paymentStatus: text("payment_status").notNull().default("NONE"),
    orderStatus: text("order_status").notNull().default("NONE"),
    state: text("state").notNull(),
    simulatedPayment: boolean("simulated_payment").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    auditId: text("audit_id"),
    campaignId: text("campaign_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("checkout_sessions_merchant_idx").on(t.merchantId),
    index("checkout_sessions_merchant_intent_idx").on(t.merchantId, t.intentId),
    index("checkout_sessions_merchant_order_idx").on(t.merchantId, t.razorpayOrderId),
    index("checkout_sessions_merchant_payment_idx").on(t.merchantId, t.razorpayPaymentId),
  ]
);

/* ------------------------------------------------------------------ */
/* Audit — hash chain kept PER MERCHANT: each tenant's chain is its own,   */
/* independently verifiable, tamper-evident ledger                         */
/* ------------------------------------------------------------------ */

export const auditLogEntries = pgTable(
  "audit_log_entries",
  {
    id: text("id").primaryKey(), // audit_id
    merchantId: text("merchant_id").notNull(),
    intentId: text("intent_id").notNull(),
    step: text("step").notNull(),
    outcome: text("outcome").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    detail: jsonb("detail").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    /** Monotonic per-merchant sequence — the real ordering key for the chain (timestamps can collide). */
    seq: integer("seq").notNull(),
  },
  (t) => [
    uniqueIndex("audit_log_merchant_seq_uq").on(t.merchantId, t.seq),
    index("audit_log_merchant_intent_idx").on(t.merchantId, t.intentId),
  ]
);

/* ------------------------------------------------------------------ */
/* Approvals / refunds / payment links / idempotency                   */
/* ------------------------------------------------------------------ */

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(), // approval_id
    merchantId: text("merchant_id").notNull(),
    checkoutSessionId: text("checkout_session_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    amountInr: doublePrecision("amount_inr").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("approvals_merchant_status_idx").on(t.merchantId, t.status)]
);

export const refundRecords = pgTable(
  "refunds",
  {
    id: text("id").primaryKey(), // refund_id
    merchantId: text("merchant_id").notNull(),
    checkoutSessionId: text("checkout_session_id").notNull(),
    razorpayRefundId: text("razorpay_refund_id"),
    amountInr: doublePrecision("amount_inr").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    simulated: boolean("simulated").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refunds_merchant_idx").on(t.merchantId)]
);

export const paymentLinkRecords = pgTable(
  "payment_links",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    checkoutSessionId: text("checkout_session_id"),
    razorpayPaymentLinkId: text("razorpay_payment_link_id"),
    shortUrl: text("short_url"),
    amountInr: doublePrecision("amount_inr").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("created"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payment_links_merchant_idx").on(t.merchantId)]
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idempotency_merchant_scope_key_uq").on(t.merchantId, t.scope, t.key)]
);

/* ------------------------------------------------------------------ */
/* Webhooks                                                             */
/*                                                                      */
/* Inbound Razorpay webhooks carry no merchant identity of their own    */
/* (Razorpay signs with one platform-wide secret in this build — see    */
/* README "One shared Razorpay account" for why). `merchantId` here is  */
/* nullable and is filled in AFTER the event is matched to a session by */
/* its order/payment id; a signature-invalid or unmatched event is      */
/* still logged for operator visibility, with merchantId left null.     */
/* ------------------------------------------------------------------ */

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(), // razorpay event id, or a hash of the body when absent
    merchantId: text("merchant_id"),
    event: text("event").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    signatureValid: boolean("signature_valid").notNull(),
    processed: boolean("processed").notNull().default(false),
    duplicate: boolean("duplicate").notNull().default(false),
    handler: text("handler").notNull().default("-"),
    attempts: integer("attempts").notNull().default(1),
    payloadSummary: jsonb("payload_summary").notNull(),
    auditId: text("audit_id"),
  },
  (t) => [index("webhook_events_merchant_idx").on(t.merchantId)]
);

/* ------------------------------------------------------------------ */
/* Outbound webhooks                                                    */
/*                                                                      */
/* The OPPOSITE direction from webhookEvents above: this merchant's own */
/* server, registered here, gets a signed HTTP POST from A-COS whenever */
/* order.created / order.blocked / approval.requested /                 */
/* audit.chain_broken happens on their tenant. Each endpoint gets its   */
/* own HMAC secret (shown once, like the agent API key) so the merchant */
/* can verify X-Acos-Signature on their receiving server.               */
/* ------------------------------------------------------------------ */

export const outboundWebhookEndpoints = pgTable(
  "outbound_webhook_endpoints",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    url: text("url").notNull(),
    /** Stored in retrievable form (never returned by any API after creation) because, unlike a login credential, THIS server must reuse it on every future delivery to sign the HMAC — there is no one-way-hash design that lets a sender re-derive a signature it must produce fresh each time. */
    secret: text("secret").notNull(),
    secretPrefix: text("secret_prefix").notNull(),
    events: jsonb("events").notNull(), // string[] subset of the four planned events
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("outbound_webhook_endpoints_merchant_idx").on(t.merchantId)]
);

export const outboundWebhookDeliveries = pgTable(
  "outbound_webhook_deliveries",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    event: text("event").notNull(),
    url: text("url").notNull(),
    success: boolean("success").notNull(),
    statusCode: integer("status_code"),
    error: text("error"),
    payloadSummary: jsonb("payload_summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbound_webhook_deliveries_merchant_idx").on(t.merchantId),
    index("outbound_webhook_deliveries_endpoint_idx").on(t.endpointId),
  ]
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    /** SHA-256 hash of the raw token — same pattern as the agent API key; the raw value only ever exists in the emailed link. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_reset_tokens_merchant_idx").on(t.merchantId)]
);

/* ------------------------------------------------------------------ */
/* Growth engine + campaigns                                           */
/* ------------------------------------------------------------------ */

export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(), // campaign_id
    merchantId: text("merchant_id").notNull(),
    name: text("name").notNull(),
    triggerIntent: text("trigger_intent").notNull(),
    productSkus: jsonb("product_skus").notNull(),
    discountInr: doublePrecision("discount_inr").notNull(),
    maxDiscountPct: doublePrecision("max_discount_pct").notNull(),
    budgetInr: doublePrecision("budget_inr").notNull(),
    spentInr: doublePrecision("spent_inr").notNull().default(0),
    dailyOrderLimit: integer("daily_order_limit").notNull().default(50),
    redemptions: integer("redemptions").notNull().default(0),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => [index("campaigns_merchant_status_idx").on(t.merchantId, t.status)]
);

export const growthLedger = pgTable(
  "growth_ledger",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    primarySku: text("primary_sku").notNull(),
    companionSku: text("companion_sku").notNull(),
    impressions: integer("impressions").notNull().default(0),
    acceptances: integer("acceptances").notNull().default(0),
    disabled: boolean("disabled").notNull().default(false),
  },
  (t) => [uniqueIndex("growth_ledger_uq").on(t.merchantId, t.primarySku, t.companionSku)]
);
