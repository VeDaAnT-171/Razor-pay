/**
 * src/schema/types.ts
 *
 * Zod models for every payload A-COS accepts or emits:
 *  - ACP (Agentic Commerce Protocol) checkout/create requests
 *  - Google AP2 signed payment mandate tokens
 *  - x402 (HTTP 402 Payment Required) headers/payload
 *  - NPCI UAP (Unified Agent Protocol) delegated-authority settlement payloads
 *  - The normalized internal "CheckoutIntent" every protocol adapter reduces to
 *  - Immutable audit log entries
 *
 * Every inbound route validates against these schemas before anything else
 * runs — malformed or unsigned mandates never reach the guardrail gate,
 * let alone Razorpay.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Shared primitives                                                   */
/* ------------------------------------------------------------------ */

export const CurrencyCode = z.enum(["INR"]);

export const CartLineItem = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  /** Unit price the agent believes is current, in INR rupees (not paise). */
  quoted_unit_price_inr: z.number().positive(),
  /** Echoes the quote issued by GET /agent/v1/catalog/quote/:sku so we can detect drift. */
  quote_id: z.string().optional(),
});
export type CartLineItem = z.infer<typeof CartLineItem>;

export const BuyerAgent = z.object({
  agent_id: z.string().min(1),
  agent_name: z.string().min(1),
  /** e.g. "openai-operator", "google-ap2-agent", "razorpay-native-agent" */
  agent_platform: z.string().min(1),
  on_behalf_of_user_id: z.string().min(1),
});
export type BuyerAgent = z.infer<typeof BuyerAgent>;

/* ------------------------------------------------------------------ */
/* Protocol 1: ACP — Agentic Commerce Protocol (OpenAI/Stripe-style)   */
/* POST /agent/v1/checkout  { protocol: "acp" }                        */
/* ------------------------------------------------------------------ */

export const ACPCheckoutCreateRequest = z.object({
  protocol: z.literal("acp"),
  checkout_session_id: z.string().min(1),
  buyer_agent: BuyerAgent,
  line_items: z.array(CartLineItem).min(1),
  currency: CurrencyCode.default("INR"),
  /** Merchant-issued spend authorization the agent was granted upstream. */
  pre_authorized_limit_inr: z.number().positive(),
  payment_method: z.string().optional(),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});
export type ACPCheckoutCreateRequest = z.infer<typeof ACPCheckoutCreateRequest>;

/* ------------------------------------------------------------------ */
/* Protocol 2: Google AP2 — signed payment mandate token               */
/* POST /agent/v1/checkout  { protocol: "ap2" }                        */
/* ------------------------------------------------------------------ */

export const AP2Mandate = z.object({
  mandate_type: z.enum(["intent_mandate", "cart_mandate"]),
  mandate_id: z.string().min(1),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  max_amount_inr: z.number().positive(),
  merchant_id: z.string().min(1),
  user_id: z.string().min(1),
});

export const AP2CheckoutCreateRequest = z.object({
  protocol: z.literal("ap2"),
  buyer_agent: BuyerAgent,
  line_items: z.array(CartLineItem).min(1),
  currency: CurrencyCode.default("INR"),
  mandate: AP2Mandate,
  /** Base64/JWS-style compact signature over the mandate — verified in guardrail_gate. */
  signed_token: z.string().min(1),
  payment_method: z.string().optional(),
});
export type AP2CheckoutCreateRequest = z.infer<typeof AP2CheckoutCreateRequest>;

/* ------------------------------------------------------------------ */
/* Protocol 3: x402 — HTTP 402 Payment Required agentic payment header */
/* POST /agent/v1/checkout  { protocol: "x402" }                       */
/* ------------------------------------------------------------------ */

export const X402Header = z.object({
  /** Mirrors the `X-PAYMENT` header content per the x402 spec, JSON-decoded. */
  x402_version: z.literal(1),
  scheme: z.literal("exact"),
  network: z.string().min(1), // e.g. "razorpay-inr-testnet" (mocked rail id for this prototype)
  payer: z.string().min(1),
  max_amount_required_inr: z.number().positive(),
  resource: z.string().min(1), // the resource/URL being paid for
  nonce: z.string().min(1),
});

export const X402CheckoutCreateRequest = z.object({
  protocol: z.literal("x402"),
  buyer_agent: BuyerAgent,
  line_items: z.array(CartLineItem).min(1),
  currency: CurrencyCode.default("INR"),
  x402: X402Header,
  payment_method: z.string().optional(),
});
export type X402CheckoutCreateRequest = z.infer<typeof X402CheckoutCreateRequest>;

/* ------------------------------------------------------------------ */
/* Protocol 4: NPCI UAP — Unified Agent Protocol / delegated UPI       */
/* Mocked settlement bridge (Reserve Pay style delegated authority)    */
/* POST /agent/v1/checkout  { protocol: "npci_uap" }                   */
/* ------------------------------------------------------------------ */

export const NPCIUAPDelegation = z.object({
  delegation_id: z.string().min(1),
  delegator_vpa: z.string().min(3), // user's UPI VPA that granted delegated authority
  delegate_agent_id: z.string().min(1),
  delegated_limit_inr: z.number().positive(),
  valid_till: z.string().datetime(),
  /** Mocked NPCI-issued delegation signature. */
  uap_signature: z.string().min(1),
});

export const NPCIUAPCheckoutCreateRequest = z.object({
  protocol: z.literal("npci_uap"),
  buyer_agent: BuyerAgent,
  line_items: z.array(CartLineItem).min(1),
  currency: CurrencyCode.default("INR"),
  delegation: NPCIUAPDelegation,
  payment_method: z.string().optional(),
});
export type NPCIUAPCheckoutCreateRequest = z.infer<typeof NPCIUAPCheckoutCreateRequest>;

/* ------------------------------------------------------------------ */
/* Discriminated union over all four inbound checkout protocols        */
/* ------------------------------------------------------------------ */

export const CheckoutCreateRequest = z.discriminatedUnion("protocol", [
  ACPCheckoutCreateRequest,
  AP2CheckoutCreateRequest,
  X402CheckoutCreateRequest,
  NPCIUAPCheckoutCreateRequest,
]);
export type CheckoutCreateRequest = z.infer<typeof CheckoutCreateRequest>;

/* ------------------------------------------------------------------ */
/* Normalized internal representation                                  */
/* Every protocol adapter in protocol_bridge.ts reduces to this before  */
/* it ever touches the guardrail gate or the Razorpay Orders API.       */
/* ------------------------------------------------------------------ */

export const CheckoutIntent = z.object({
  intent_id: z.string().min(1),
  source_protocol: z.enum(["acp", "ap2", "x402", "npci_uap"]),
  buyer_agent: BuyerAgent,
  line_items: z.array(CartLineItem).min(1),
  currency: CurrencyCode,
  /** The spend ceiling this specific mandate authorizes, in INR rupees. */
  authorized_limit_inr: z.number().positive(),
  /** Sum of quoted_unit_price_inr * quantity across line items, at intent time. */
  cart_total_inr: z.number().positive(),
  merchant_reference: z.string().min(1),
});
export type CheckoutIntent = z.infer<typeof CheckoutIntent>;

/* ------------------------------------------------------------------ */
/* Audit log                                                            */
/* ------------------------------------------------------------------ */

export const AuditStep = z.enum([
  "INTENT_RECEIVED",
  "PROTOCOL_TRANSLATED",
  "POLICY_CHECK",
  "MANDATE_VERIFICATION",
  "NEGOTIATION",
  "RECOMMENDATION",
  "SETTLEMENT",
  "FAILURE",
  "ORDER_CREATED",
  "PAYMENT_INITIATED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_CAPTURED",
  "PAYMENT_FAILED",
  "SIMULATED_PAYMENT_EVENT",
  "APPROVAL_REQUESTED",
  "APPROVAL_APPROVED",
  "APPROVAL_REJECTED",
  "AUTHORIZATION_MODIFIED",
  "REFUND_REQUESTED",
  "REFUND_PROCESSED",
  "PAYMENT_LINK_CREATED",
  "WEBHOOK_RECEIVED",
  "WEBHOOK_VERIFIED",
  "WEBHOOK_REJECTED",
  "IDEMPOTENT_REPLAY",
  "VELOCITY_CHECK",
  "CAMPAIGN_APPLIED",
  "INVENTORY_HELD",
  "INVENTORY_RELEASED",
  "INVENTORY_CONSUMED",
  "STOREFRONT_CONVERSATION",
]);
export type AuditStep = z.infer<typeof AuditStep>;

export const AuditLogEntry = z.object({
  audit_id: z.string().min(1),
  intent_id: z.string().min(1),
  step: AuditStep,
  outcome: z.enum(["PASS", "FAIL", "INFO"]),
  timestamp: z.string().datetime(),
  actor: z.string().min(1), // e.g. "guardrail_gate", "protocol_bridge", "razorpay"
  reason: z.string().min(1),
  /** Free-form, protocol/step-specific data — kept for explainability, never mutated after write. */
  detail: z.record(z.unknown()).default({}),
  /** SHA-256 of the previous entry's hash, chaining the log for tamper-evidence. */
  prev_hash: z.string(),
  hash: z.string(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;

/* ------------------------------------------------------------------ */
/* Guardrail policy config                                             */
/* ------------------------------------------------------------------ */

export const GuardrailPolicy = z.object({
  auto_approve_limit_inr: z.number().positive(),
  max_auto_discount_pct: z.number().min(0).max(100),
  allowed_mcc: z.array(z.string()).default(["5399", "5732", "5734"]), // example retail/electronics MCCs
  require_signature: z.boolean().default(true),
});
export type GuardrailPolicy = z.infer<typeof GuardrailPolicy>;

/* ------------------------------------------------------------------ */
/* Negotiation                                                         */
/* ------------------------------------------------------------------ */

export const NegotiationOffer = z.object({
  intent_id: z.string().min(1),
  sku: z.string().min(1),
  requested_discount_pct: z.number().min(0).max(100),
  buyer_justification: z.string().optional(),
});
export type NegotiationOffer = z.infer<typeof NegotiationOffer>;

export const NegotiationResponse = z.object({
  intent_id: z.string().min(1),
  sku: z.string().min(1),
  decision: z.enum(["ACCEPTED", "COUNTERED", "REJECTED"]),
  approved_discount_pct: z.number().min(0).max(100),
  final_unit_price_inr: z.number().positive(),
  reason: z.string(),
});
export type NegotiationResponse = z.infer<typeof NegotiationResponse>;

/* ------------------------------------------------------------------ */
/* Failure / recovery                                                  */
/* ------------------------------------------------------------------ */

export const RecoveryChoice = z.enum([
  "ADJUST_QUANTITY",
  "REQUEST_HUMAN_APPROVAL",
  "ABORT",
]);
export type RecoveryChoice = z.infer<typeof RecoveryChoice>;

export const MandateBreachResponse = z.object({
  error: z.literal("MANDATE_BREACH"),
  intent_id: z.string(),
  reason: z.string(),
  authorized_limit_inr: z.number(),
  attempted_total_inr: z.number(),
  drift_inr: z.number(),
  reserved_funds_released: z.boolean(),
  recovery_choices: z.array(RecoveryChoice),
  audit_id: z.string(),
});
export type MandateBreachResponse = z.infer<typeof MandateBreachResponse>;

/* ------------------------------------------------------------------ */
/* Canonical transaction lifecycle                                     */
/*                                                                      */
/* A Razorpay ORDER being created is NOT the same thing as a payment    */
/* succeeding. These are two different facts and the session tracks    */
/* both independently: order_status vs payment_status. The UI must     */
/* never collapse "order created" into "paid".                         */
/* ------------------------------------------------------------------ */

export const TransactionState = z.enum([
  "INTENT",
  "AUTHORIZED",
  "QUOTE_VALIDATED",
  "POLICY_CHECKED",
  "APPROVED",
  "ORDER_CREATED",
  "PAYMENT_INITIATED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_CAPTURED",
  "ORDER_PAID",
  "FULFILLMENT",
  // failure / terminal states
  "BLOCKED",
  "EXPIRED",
  "REJECTED",
  "REQUIRES_HUMAN",
  "PAYMENT_FAILED",
  "TIMEOUT",
  "CANCELLED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);
export type TransactionState = z.infer<typeof TransactionState>;

/** States in which real money has actually moved (captured). Never true from order creation alone. */
export const PAID_STATES: TransactionState[] = ["PAYMENT_CAPTURED", "ORDER_PAID", "FULFILLMENT"];

export const CheckoutSession = z.object({
  checkout_session_id: z.string(),
  merchant_id: z.string(),
  customer_id: z.string().optional(),
  buyer_agent_id: z.string(),
  protocol: z.enum(["acp", "ap2", "x402", "npci_uap"]),
  intent_id: z.string(),
  cart: z.array(CartLineItem),
  quote_id: z.string().optional(),
  authorization_inr: z.number(),
  policy_version: z.number(),
  policy_decision: z.enum(["APPROVED", "REQUIRES_HUMAN", "BLOCKED"]).optional(),
  risk_decision: z.enum(["LOW", "MEDIUM", "HIGH"]).default("LOW"),
  shipping_inr: z.number().default(0),
  tax_inr: z.number().default(0),
  discount_inr: z.number().default(0),
  final_amount_inr: z.number(),
  currency: CurrencyCode,
  payment_method: z.string().optional(),
  razorpay_order_id: z.string().optional(),
  razorpay_payment_id: z.string().optional(),
  payment_status: z.enum(["NONE", "INITIATED", "AUTHORIZED", "CAPTURED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"]).default("NONE"),
  order_status: z.enum(["NONE", "CREATED", "PAID", "CANCELLED"]).default("NONE"),
  state: TransactionState,
  simulated_payment: z.boolean().default(false),
  expires_at: z.string().datetime().optional(),
  idempotency_key: z.string().optional(),
  audit_id: z.string().optional(),
  /** Set when an active campaign's discount was applied to this cart at checkout time. */
  campaign_id: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type CheckoutSession = z.infer<typeof CheckoutSession>;

/* ------------------------------------------------------------------ */
/* Policy v2 — velocity, product/discount/payment-method authority      */
/* ------------------------------------------------------------------ */

export const VelocityLimits = z.object({
  per_transaction_inr: z.number().positive().optional(),
  hourly_inr: z.number().positive().optional(),
  daily_inr: z.number().positive().optional(),
  monthly_inr: z.number().positive().optional(),
  max_transactions_per_hour: z.number().int().positive().optional(),
  max_transactions_per_day: z.number().int().positive().optional(),
  max_failed_attempts_per_hour: z.number().int().positive().optional(),
});
export type VelocityLimits = z.infer<typeof VelocityLimits>;

export const PolicyV2 = z.object({
  version: z.number().int().positive(),
  status: z.enum(["draft", "published"]),
  auto_approve_limit_inr: z.number().positive(),
  velocity: VelocityLimits,
  allowed_categories: z.array(z.string()).default([]),
  blocked_categories: z.array(z.string()).default([]),
  max_quantity_per_item: z.number().int().positive().default(5),
  max_auto_discount_pct: z.number().min(0).max(100),
  max_absolute_discount_inr: z.number().min(0).optional(),
  allowed_payment_methods: z.array(z.string()).default(["card", "upi", "netbanking", "wallet"]),
  blocked_payment_methods: z.array(z.string()).default([]),
  new_customer_limit_inr: z.number().positive().optional(),
  human_approval_new_category: z.boolean().default(true),
  human_approval_address_change: z.boolean().default(true),
  human_approval_payment_method_change: z.boolean().default(true),
  created_at: z.string().datetime(),
  published_at: z.string().datetime().optional(),
});
export type PolicyV2 = z.infer<typeof PolicyV2>;

export const AgentProfile = z.object({
  agent_id: z.string(),
  verified: z.boolean().default(true),
  protocol: z.string(),
  per_transaction_inr: z.number(),
  hourly_inr: z.number(),
  daily_inr: z.number(),
  monthly_inr: z.number(),
  discount_authority_pct: z.number(),
  max_quantity: z.number(),
  allowed_categories: z.array(z.string()),
  restricted_categories: z.array(z.string()),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

/* ------------------------------------------------------------------ */
/* Refunds                                                              */
/* ------------------------------------------------------------------ */

export const RefundRequest = z.object({
  checkout_session_id: z.string(),
  amount_inr: z.number().positive().optional(), // omit = full refund
  reason: z.string().min(1),
  idempotency_key: z.string().optional(),
});
export type RefundRequest = z.infer<typeof RefundRequest>;

/* ------------------------------------------------------------------ */
/* Payment Links (recovery path when autonomous checkout can't finish)  */
/* ------------------------------------------------------------------ */

export const PaymentLinkRequest = z.object({
  checkout_session_id: z.string().optional(),
  amount_inr: z.number().positive(),
  description: z.string().min(1),
  customer_name: z.string().optional(),
  customer_email: z.string().email().optional(),
  customer_contact: z.string().optional(),
});
export type PaymentLinkRequest = z.infer<typeof PaymentLinkRequest>;

/* ------------------------------------------------------------------ */
/* Approvals                                                            */
/* ------------------------------------------------------------------ */

export const ApprovalAction = z.object({
  approval_id: z.string(),
  action: z.enum(["approve", "reject", "modify"]),
  modified_limit_inr: z.number().positive().optional(),
  note: z.string().optional(),
});
export type ApprovalAction = z.infer<typeof ApprovalAction>;

/* ------------------------------------------------------------------ */
/* Growth — upsell/cross-sell engine + campaign opportunity detection   */
/*                                                                      */
/* "confidence" tells the caller whether the impact numbers below are   */
/* backed by observed acceptance data from real carts (LIVE) or, when   */
/* too few real carts have been seen yet, a baseline heuristic model    */
/* derived from catalog margin/price data (ESTIMATED). Never presented  */
/* as LIVE unless it is actually computed from recorded impressions.    */
/* ------------------------------------------------------------------ */

export const GrowthRecommendation = z.object({
  primary_sku: z.string(),
  primary_name: z.string(),
  companion_sku: z.string(),
  companion_name: z.string(),
  companion_price_inr: z.number(),
  reason: z.string(),
  enabled: z.boolean(),
  confidence: z.enum(["LIVE", "ESTIMATED"]),
  impressions: z.number().int().nonnegative(),
  acceptances: z.number().int().nonnegative(),
  acceptance_rate_pct: z.number().min(0).max(100),
  expected_incremental_revenue_inr: z.number().nonnegative(),
  expected_conversion_impact_pct: z.number(),
  expected_margin_inr: z.number().nonnegative(),
  inventory_available: z.number().int().nonnegative(),
  inventory_note: z.string(),
});
export type GrowthRecommendation = z.infer<typeof GrowthRecommendation>;

export const GrowthOpportunity = z.object({
  opportunity_id: z.string(),
  primary_sku: z.string(),
  companion_sku: z.string(),
  headline: z.string(),
  evidence: z.string(),
  confidence: z.enum(["LIVE", "ESTIMATED"]),
  potential_monthly_revenue_inr: z.number().nonnegative(),
  already_has_active_campaign: z.boolean(),
  suggested_campaign: z.object({
    name: z.string(),
    trigger_intent: z.string(),
    product_skus: z.array(z.string()),
    discount_inr: z.number(),
    budget_inr: z.number(),
    daily_order_limit: z.number(),
  }),
});
export type GrowthOpportunity = z.infer<typeof GrowthOpportunity>;
