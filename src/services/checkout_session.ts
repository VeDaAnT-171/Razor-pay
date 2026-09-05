/**
 * src/services/checkout_session.ts
 *
 * The canonical, server-authoritative transaction record — merchant-scoped
 * and Postgres-backed. Every checkout — regardless of source protocol —
 * creates exactly one CheckoutSession, and every subsequent fact about
 * that transaction (policy decision, Razorpay order id, payment status,
 * refunds) is written onto this same row. The browser only ever *displays*
 * a session; it cannot create, price, or authorize one.
 *
 * Critically: `order_status` and `payment_status` are tracked separately.
 * Creating a Razorpay order sets order_status="CREATED" — it does NOT
 * touch payment_status. Only a real webhook (webhooks.ts) or an
 * explicitly-labeled simulated test-lab event can move payment_status
 * forward, and simulated transitions are permanently flagged
 * `simulated_payment: true` on the session so the UI can never present
 * them as real captured revenue.
 */

import { randomUUID } from "crypto";
import { CheckoutSession, TransactionState } from "../schema/types";
import { writeAudit } from "./audit_log";
import * as repo from "../db/sessions";

/** Legal forward transitions. Anything not listed here is refused. */
const TRANSITIONS: Record<TransactionState, TransactionState[]> = {
  INTENT: ["AUTHORIZED", "REJECTED", "BLOCKED"],
  AUTHORIZED: ["QUOTE_VALIDATED", "EXPIRED", "REJECTED"],
  QUOTE_VALIDATED: ["POLICY_CHECKED", "EXPIRED", "BLOCKED"],
  POLICY_CHECKED: ["APPROVED", "REQUIRES_HUMAN", "BLOCKED"],
  REQUIRES_HUMAN: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["ORDER_CREATED", "CANCELLED"],
  ORDER_CREATED: ["PAYMENT_INITIATED", "CANCELLED", "TIMEOUT"],
  PAYMENT_INITIATED: ["PAYMENT_AUTHORIZED", "PAYMENT_FAILED", "TIMEOUT"],
  PAYMENT_AUTHORIZED: ["PAYMENT_CAPTURED", "PAYMENT_FAILED"],
  PAYMENT_CAPTURED: ["ORDER_PAID"],
  ORDER_PAID: ["FULFILLMENT", "REFUNDED", "PARTIALLY_REFUNDED"],
  FULFILLMENT: ["REFUNDED", "PARTIALLY_REFUNDED"],
  PAYMENT_FAILED: ["PAYMENT_INITIATED", "CANCELLED"],
  BLOCKED: [],
  EXPIRED: [],
  REJECTED: [],
  TIMEOUT: ["PAYMENT_INITIATED", "CANCELLED"],
  CANCELLED: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: ["REFUNDED"],
};

export function canTransition(from: TransactionState, to: TransactionState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

function toDomain(row: repo.SessionRow): CheckoutSession {
  return {
    checkout_session_id: row.id,
    merchant_id: row.merchantId,
    customer_id: row.customerId ?? undefined,
    buyer_agent_id: row.buyerAgentId,
    protocol: row.protocol as CheckoutSession["protocol"],
    intent_id: row.intentId,
    cart: row.cart as CheckoutSession["cart"],
    quote_id: row.quoteId ?? undefined,
    authorization_inr: row.authorizationInr,
    policy_version: row.policyVersion,
    policy_decision: (row.policyDecision as CheckoutSession["policy_decision"]) ?? undefined,
    risk_decision: row.riskDecision as CheckoutSession["risk_decision"],
    shipping_inr: row.shippingInr,
    tax_inr: row.taxInr,
    discount_inr: row.discountInr,
    final_amount_inr: row.finalAmountInr,
    currency: row.currency as CheckoutSession["currency"],
    payment_method: row.paymentMethod ?? undefined,
    razorpay_order_id: row.razorpayOrderId ?? undefined,
    razorpay_payment_id: row.razorpayPaymentId ?? undefined,
    payment_status: row.paymentStatus as CheckoutSession["payment_status"],
    order_status: row.orderStatus as CheckoutSession["order_status"],
    state: row.state as TransactionState,
    simulated_payment: row.simulatedPayment,
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : undefined,
    idempotency_key: row.idempotencyKey ?? undefined,
    audit_id: row.auditId ?? undefined,
    campaign_id: row.campaignId ?? undefined,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface CreateSessionParams {
  merchant_id: string;
  customer_id?: string;
  buyer_agent_id: string;
  protocol: CheckoutSession["protocol"];
  intent_id: string;
  cart: CheckoutSession["cart"];
  authorization_inr: number;
  policy_version: number;
  final_amount_inr: number;
  currency: CheckoutSession["currency"];
  quote_id?: string;
  idempotency_key?: string;
  discount_inr?: number;
  campaign_id?: string;
}

export async function createSession(params: CreateSessionParams): Promise<CheckoutSession> {
  const id = `cs_${randomUUID()}`;
  const row = await repo.insertSession({
    id,
    merchantId: params.merchant_id,
    customerId: params.customer_id ?? null,
    buyerAgentId: params.buyer_agent_id,
    protocol: params.protocol,
    intentId: params.intent_id,
    cart: params.cart,
    quoteId: params.quote_id ?? null,
    authorizationInr: params.authorization_inr,
    policyVersion: params.policy_version,
    policyDecision: null,
    riskDecision: "LOW",
    shippingInr: 0,
    taxInr: 0,
    discountInr: params.discount_inr ?? 0,
    finalAmountInr: params.final_amount_inr,
    currency: params.currency,
    paymentMethod: null,
    razorpayOrderId: null,
    razorpayPaymentId: null,
    paymentStatus: "NONE",
    orderStatus: "NONE",
    state: "INTENT",
    simulatedPayment: false,
    expiresAt: null,
    idempotencyKey: params.idempotency_key ?? null,
    auditId: null,
    campaignId: params.campaign_id ?? null,
  });
  return toDomain(row);
}

export async function getSession(merchantId: string, id: string): Promise<CheckoutSession | undefined> {
  const row = await repo.findSessionById(merchantId, id);
  return row ? toDomain(row) : undefined;
}

export async function getSessionByIntent(merchantId: string, intentId: string): Promise<CheckoutSession | undefined> {
  const row = await repo.findSessionByIntent(merchantId, intentId);
  return row ? toDomain(row) : undefined;
}

export async function getSessionByOrderOrPayment(
  merchantId: string,
  orderId?: string,
  paymentId?: string
): Promise<CheckoutSession | undefined> {
  const row = await repo.findSessionByOrderOrPayment(merchantId, orderId, paymentId);
  return row ? toDomain(row) : undefined;
}

export async function listSessions(merchantId: string): Promise<CheckoutSession[]> {
  const rows = await repo.listSessions(merchantId);
  return rows.map(toDomain);
}

/** Partial<CheckoutSession> patch fields, using the domain (snake_case) shape callers already use. */
export type SessionPatch = Partial<
  Pick<
    CheckoutSession,
    | "authorization_inr"
    | "policy_decision"
    | "risk_decision"
    | "shipping_inr"
    | "tax_inr"
    | "discount_inr"
    | "final_amount_inr"
    | "payment_method"
    | "razorpay_order_id"
    | "razorpay_payment_id"
    | "payment_status"
    | "order_status"
    | "simulated_payment"
    | "audit_id"
    | "campaign_id"
    | "expires_at"
  >
>;

function patchToRow(patch: SessionPatch): Partial<repo.SessionRow> {
  const out: Partial<repo.SessionRow> = {};
  if (patch.authorization_inr !== undefined) out.authorizationInr = patch.authorization_inr;
  if (patch.policy_decision !== undefined) out.policyDecision = patch.policy_decision;
  if (patch.risk_decision !== undefined) out.riskDecision = patch.risk_decision;
  if (patch.shipping_inr !== undefined) out.shippingInr = patch.shipping_inr;
  if (patch.tax_inr !== undefined) out.taxInr = patch.tax_inr;
  if (patch.discount_inr !== undefined) out.discountInr = patch.discount_inr;
  if (patch.final_amount_inr !== undefined) out.finalAmountInr = patch.final_amount_inr;
  if (patch.payment_method !== undefined) out.paymentMethod = patch.payment_method;
  if (patch.razorpay_order_id !== undefined) out.razorpayOrderId = patch.razorpay_order_id;
  if (patch.razorpay_payment_id !== undefined) out.razorpayPaymentId = patch.razorpay_payment_id;
  if (patch.payment_status !== undefined) out.paymentStatus = patch.payment_status;
  if (patch.order_status !== undefined) out.orderStatus = patch.order_status;
  if (patch.simulated_payment !== undefined) out.simulatedPayment = patch.simulated_payment;
  if (patch.audit_id !== undefined) out.auditId = patch.audit_id;
  if (patch.campaign_id !== undefined) out.campaignId = patch.campaign_id;
  if (patch.expires_at !== undefined) out.expiresAt = patch.expires_at ? new Date(patch.expires_at) : null;
  return out;
}

/**
 * The only way a session's state is allowed to change. Refuses illegal
 * transitions (server authority, not convention) and writes an audit
 * entry either way — including the refusal itself.
 */
export async function transitionSession(
  merchantId: string,
  id: string,
  to: TransactionState,
  actor: string,
  reason: string,
  patch: SessionPatch = {}
): Promise<CheckoutSession> {
  const session = await repo.findSessionById(merchantId, id);
  if (!session) throw new Error(`Unknown checkout_session_id: ${id}`);

  if (!canTransition(session.state as TransactionState, to)) {
    await writeAudit(merchantId, {
      intent_id: session.intentId,
      step: "FAILURE",
      outcome: "FAIL",
      actor,
      reason: `Illegal state transition refused: ${session.state} -> ${to}`,
      detail: { checkout_session_id: id, from: session.state, to },
    });
    throw new Error(`Illegal transition ${session.state} -> ${to} for session ${id}`);
  }

  const row = await repo.updateSession(merchantId, id, { ...patchToRow(patch), state: to });
  return toDomain(row);
}

/** True only for a state where money has actually, verifiably moved. */
export function isPaid(session: CheckoutSession): boolean {
  return session.payment_status === "CAPTURED" && !session.simulated_payment;
}

export async function resetSessionsForTests(merchantId: string): Promise<void> {
  await repo.clearForMerchant(merchantId);
}
