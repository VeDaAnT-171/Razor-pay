/**
 * src/middleware/guardrail_gate.ts
 *
 * The Audit Engine & Failure Guardrail Gate — merchant-scoped. Three
 * responsibilities:
 *
 *  1. Policy evaluator — spend caps, MCC restrictions, signature
 *     verification. `runGuardrailGate()` is called by protocol_bridge.ts
 *     for every checkout intent before a Razorpay Order is created.
 *
 *  2. Audit log generator — thin wrappers around services/audit_log.ts
 *     used consistently across the codebase so every guardrail decision
 *     is attributed to actor "guardrail_gate".
 *
 *  3. The Price Drift / Mandate Breach failure-simulation route:
 *     POST /agent/v1/checkout/simulate-failure
 */

import { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import {
  GuardrailPolicy,
  CheckoutIntent,
  MandateBreachResponse,
  RecoveryChoice,
  PolicyV2,
} from "../schema/types";
import { writeAudit } from "../services/audit_log";
import { findProduct, forcePriceDrift } from "../services/catalog";
import { issueQuote } from "../services/quote_store";
import { getPublishedPolicy, checkVelocity, recordVelocityEvent } from "../services/policy_store";
import { requireAgentAuth } from "./auth";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

/** Backward-compat shim — old callers (negotiation.ts) still get {auto_approve_limit_inr, max_auto_discount_pct}. */
export async function getDefaultPolicy(merchantId: string): Promise<GuardrailPolicy> {
  const v2 = await getPublishedPolicy(merchantId);
  return GuardrailPolicy.parse({
    auto_approve_limit_inr: v2.auto_approve_limit_inr,
    max_auto_discount_pct: v2.max_auto_discount_pct,
    allowed_mcc: ["5399", "5732", "5734"],
    require_signature: true,
  });
}

const SIGNING_SECRET = () => process.env.A_COS_MANDATE_SIGNING_SECRET ?? "change-me-in-production";

/* ------------------------------------------------------------------ */
/* Signature verification (mocks AP2 JWS / NPCI UAP signature checks)  */
/* ------------------------------------------------------------------ */

/**
 * HMAC-SHA256 mock of mandate-signature verification. In production this
 * would validate a JWS (AP2) or NPCI-issued signature against a published
 * key; here we compute an HMAC over the canonical payload with a shared
 * secret so the demo has a real, checkable signature rather than a stub
 * that always passes.
 */
export function signPayload(canonicalPayload: string): string {
  return createHmac("sha256", SIGNING_SECRET()).update(canonicalPayload).digest("hex");
}

export function verifySignature(canonicalPayload: string, providedSignature: string): boolean {
  const expected = signPayload(canonicalPayload);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(providedSignature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Policy evaluator                                                     */
/* ------------------------------------------------------------------ */

export interface PolicyCheckResult {
  pass: boolean;
  requiresHumanApproval: boolean;
  failures: string[];
  velocityUsage?: Awaited<ReturnType<typeof checkVelocity>>["usage"];
}

/**
 * Policy v2 evaluator — the one actually used by the checkout path.
 * Adds: category allow/block, per-item quantity ceiling, payment-method
 * enforcement, and real velocity limits (hourly/daily/monthly spend +
 * transaction-count + failed-attempt safety cap), on top of the original
 * spend-cap check. Every check here can independently block a checkout.
 */
export async function evaluatePolicyV2(
  merchantId: string,
  intent: CheckoutIntent,
  policy: PolicyV2,
  paymentMethod?: string
): Promise<PolicyCheckResult> {
  const failures: string[] = [];

  if (intent.cart_total_inr > intent.authorized_limit_inr) {
    failures.push(`Cart total ₹${intent.cart_total_inr} exceeds mandate-authorized limit ₹${intent.authorized_limit_inr}`);
  }

  for (const item of intent.line_items) {
    const product = await findProduct(merchantId, item.sku);
    if (!product) {
      failures.push(`Unknown SKU in cart: ${item.sku}`);
      continue;
    }
    if (policy.blocked_categories.some((c) => product.category.startsWith(c) || c === product.category)) {
      failures.push(`${product.name} is in a blocked category (${product.category})`);
    }
    if (policy.allowed_categories.length && !policy.allowed_categories.some((c) => product.category.startsWith(c) || c === product.category)) {
      failures.push(`${product.name}'s category (${product.category}) is not in the allowed list`);
    }
    if (item.quantity > policy.max_quantity_per_item) {
      failures.push(`Quantity ${item.quantity} for ${item.sku} exceeds per-item cap of ${policy.max_quantity_per_item}`);
    }
  }

  if (paymentMethod) {
    if (policy.blocked_payment_methods.includes(paymentMethod)) {
      failures.push(`Payment method "${paymentMethod}" is blocked by policy`);
    } else if (policy.allowed_payment_methods.length && !policy.allowed_payment_methods.includes(paymentMethod)) {
      failures.push(`Payment method "${paymentMethod}" is not in the allowed list (${policy.allowed_payment_methods.join(", ")})`);
    }
  }

  const velocity = await checkVelocity(merchantId, intent.buyer_agent.agent_id, intent.cart_total_inr, policy);
  if (!velocity.pass) failures.push(...velocity.failures);

  const requiresHumanApproval = failures.length === 0 && intent.cart_total_inr > policy.auto_approve_limit_inr;

  return { pass: failures.length === 0, requiresHumanApproval, failures, velocityUsage: velocity.usage };
}

/* ------------------------------------------------------------------ */
/* Guardrail gate entry point — called by protocol_bridge.ts            */
/* ------------------------------------------------------------------ */

export interface GuardrailGateResult {
  approved: boolean;
  requiresHumanApproval: boolean;
  auditId: string;
  reasons: string[];
  policyVersion: number;
  velocityUsage?: Awaited<ReturnType<typeof checkVelocity>>["usage"];
}

export async function runGuardrailGate(merchantId: string, intent: CheckoutIntent, paymentMethod?: string): Promise<GuardrailGateResult> {
  const policy = await getPublishedPolicy(merchantId);
  const result = await evaluatePolicyV2(merchantId, intent, policy, paymentMethod);

  // Record this attempt in the velocity ledger regardless of outcome —
  // failed attempts count toward the failed-attempt safety cap; only a
  // passing attempt counts toward spend totals (see policy_store.ts).
  await recordVelocityEvent(merchantId, intent.buyer_agent.agent_id, intent.cart_total_inr, !result.pass);

  const audit = await writeAudit(merchantId, {
    intent_id: intent.intent_id,
    step: "POLICY_CHECK",
    outcome: result.pass ? (result.requiresHumanApproval ? "INFO" : "PASS") : "FAIL",
    actor: "guardrail_gate",
    reason: result.pass
      ? result.requiresHumanApproval
        ? `Cart total ₹${intent.cart_total_inr} exceeds auto-approve limit ₹${policy.auto_approve_limit_inr} (policy v${policy.version}) — routing to human approval`
        : `Policy v${policy.version} checks passed (category, quantity, payment method, velocity)`
      : `Policy v${policy.version} check failed: ${result.failures.join("; ")}`,
    detail: {
      cart_total_inr: intent.cart_total_inr,
      authorized_limit_inr: intent.authorized_limit_inr,
      auto_approve_limit_inr: policy.auto_approve_limit_inr,
      policy_version: policy.version,
      failures: result.failures,
      velocity_usage: result.velocityUsage,
    },
  });

  return {
    approved: result.pass && !result.requiresHumanApproval,
    requiresHumanApproval: result.requiresHumanApproval,
    auditId: audit.audit_id,
    reasons: result.failures,
    policyVersion: policy.version,
    velocityUsage: result.velocityUsage,
  };
}

/**
 * Mock atomic unlock of funds reserved against a mandate. In production
 * this would call back into the settlement rail (Razorpay / NPCI UAP) to
 * void a reserved authorization. Here it's a deterministic no-op that
 * always succeeds and is fully audited.
 */
export async function releaseReservedFunds(merchantId: string, intentId: string, amountInr: number): Promise<boolean> {
  await writeAudit(merchantId, {
    intent_id: intentId,
    step: "FAILURE",
    outcome: "INFO",
    actor: "guardrail_gate",
    reason: `Atomically released ₹${amountInr} of reserved funds back to the mandate`,
    detail: { released_amount_inr: amountInr },
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Route: POST /agent/v1/checkout/simulate-failure                     */
/* Deterministic demo of the Price Drift / Mandate Breach scenario:    */
/*   ₹700 -> ₹790 mid-transaction, 2 units = ₹1,580 > ₹1,500 limit     */
/* ------------------------------------------------------------------ */

export interface SimulateFailureBody {
  sku?: string;
  quantity?: number;
  authorized_limit_inr?: number;
  drift_to_unit_price_inr?: number;
}

/**
 * The core Price Drift / Mandate Breach scenario, extracted so both the
 * HTTP route and the in-process Test Lab (test_lab.ts) exercise the exact
 * same real logic — no separate "demo version" of this behavior exists.
 */
export async function simulatePriceDrift(merchantId: string, input: SimulateFailureBody): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const {
    sku = "SKU-HEADPHONE-700",
    quantity = 2,
    authorized_limit_inr = 1500,
    drift_to_unit_price_inr = 790,
  } = input ?? {};

  const product = await findProduct(merchantId, sku);
  if (!product) {
    return { httpStatus: 404, body: { error: `Unknown SKU: ${sku}` } };
  }
  const originalPrice = product.price_inr;

  const intentId = `intent_sim_${Date.now()}`;

  await writeAudit(merchantId, {
    intent_id: intentId,
    step: "INTENT_RECEIVED",
    outcome: "INFO",
    actor: "guardrail_gate",
    reason: `Simulated checkout intent for ${quantity} x ${sku}`,
    detail: { sku, quantity, authorized_limit_inr },
  });

  // Step 1: agent fetches a quote at the current (pre-drift) price.
  const quote = (await issueQuote(merchantId, sku))!;
  const reservedAmount = quote.unit_price_inr * quantity;

  await writeAudit(merchantId, {
    intent_id: intentId,
    step: "MANDATE_VERIFICATION",
    outcome: "PASS",
    actor: "guardrail_gate",
    reason: `Funds reserved against mandate at quoted price ₹${quote.unit_price_inr}/unit`,
    detail: { quote_id: quote.quote_id, reserved_amount_inr: reservedAmount },
  });

  // Step 2: merchant-side reprice happens mid-transaction (simulated).
  await forcePriceDrift(merchantId, sku, drift_to_unit_price_inr);
  const liveProduct = (await findProduct(merchantId, sku))!;
  const attemptedTotal = liveProduct.price_inr * quantity;

  await writeAudit(merchantId, {
    intent_id: intentId,
    step: "POLICY_CHECK",
    outcome: "INFO",
    actor: "guardrail_gate",
    reason: `Live price for ${sku} drifted from ₹${originalPrice} to ₹${liveProduct.price_inr} before settlement`,
    detail: { original_unit_price_inr: originalPrice, new_unit_price_inr: liveProduct.price_inr },
  });

  // Restore catalog state immediately so the demo is repeatable.
  await forcePriceDrift(merchantId, sku, originalPrice);

  const drift = attemptedTotal - authorized_limit_inr;

  if (attemptedTotal <= authorized_limit_inr) {
    // No breach in this configuration — settle normally and say so.
    const audit = await writeAudit(merchantId, {
      intent_id: intentId,
      step: "SETTLEMENT",
      outcome: "PASS",
      actor: "guardrail_gate",
      reason: `Post-drift total ₹${attemptedTotal} is within authorized limit ₹${authorized_limit_inr} — no breach`,
      detail: { attempted_total_inr: attemptedTotal },
    });
    return {
      httpStatus: 200,
      body: {
        status: "SETTLED_NO_BREACH",
        intent_id: intentId,
        attempted_total_inr: attemptedTotal,
        authorized_limit_inr,
        audit_id: audit.audit_id,
      },
    };
  }

  // Breach: halt execution, atomically release reserved funds.
  await releaseReservedFunds(merchantId, intentId, reservedAmount);

  const recovery_choices: RecoveryChoice[] = ["ADJUST_QUANTITY", "REQUEST_HUMAN_APPROVAL"];

  const failureAudit = await writeAudit(merchantId, {
    intent_id: intentId,
    step: "FAILURE",
    outcome: "FAIL",
    actor: "guardrail_gate",
    reason: `Mandate breach: attempted total ₹${attemptedTotal} exceeds pre-authorized limit ₹${authorized_limit_inr} by ₹${drift}`,
    detail: {
      sku,
      quantity,
      attempted_total_inr: attemptedTotal,
      authorized_limit_inr,
      drift_inr: drift,
      recovery_choices,
    },
  });

  const breachBody: MandateBreachResponse = {
    error: "MANDATE_BREACH",
    intent_id: intentId,
    reason: `Price drift pushed cart total to ₹${attemptedTotal}, exceeding the ₹${authorized_limit_inr} pre-authorized limit by ₹${drift}.`,
    authorized_limit_inr,
    attempted_total_inr: attemptedTotal,
    drift_inr: drift,
    reserved_funds_released: true,
    recovery_choices,
    audit_id: failureAudit.audit_id,
  };

  return { httpStatus: 422, body: breachBody as unknown as Record<string, unknown> };
}

export function registerGuardrailRoutes(app: FastifyInstance) {
  app.post<{ Body: SimulateFailureBody }>(
    "/agent/v1/checkout/simulate-failure",
    { preHandler: requireAgentAuth },
    async (request, reply) => {
      const result = await simulatePriceDrift(request.merchantId!, request.body ?? {});
      return reply.status(result.httpStatus).send(result.body);
    }
  );
}
