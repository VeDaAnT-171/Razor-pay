/**
 * src/services/protocol_bridge.ts
 *
 * The protocol adapter layer — merchant-scoped. Each of the four inbound
 * agentic-payment protocols (ACP, AP2, x402, NPCI UAP) is reduced to a
 * single normalized `CheckoutIntent`, mandate-verified in its own
 * protocol-specific way, then run through the shared guardrail gate
 * before a real Razorpay Order is created in test mode.
 *
 * This file is the "translate inbound agent payloads into standard
 * Razorpay Orders API requests" piece of A-COS. Every checkout runs
 * against the merchant identified by the caller's API key (see
 * middleware/auth.ts) — nothing here ever guesses or defaults a merchant.
 */

import { randomUUID } from "crypto";
import {
  ACPCheckoutCreateRequest,
  AP2CheckoutCreateRequest,
  CheckoutCreateRequest,
  CheckoutIntent,
  NPCIUAPCheckoutCreateRequest,
  X402CheckoutCreateRequest,
} from "../schema/types";
import { writeAudit } from "./audit_log";
import { runGuardrailGate, verifySignature } from "../middleware/guardrail_gate";
import { createRazorpayOrder } from "./razorpay_client";
import { findProduct } from "./catalog";
import { createSession, transitionSession } from "./checkout_session";
import { CheckoutSession as CheckoutSessionRecord } from "../schema/types";
import { getPublishedPolicy } from "./policy_store";
import { createApproval } from "./approvals";
import { getIdempotentResult, saveIdempotentResult } from "./idempotency";
import { findActiveCampaignForSku, recordCampaignRedemption } from "./campaigns";
import { recordAcceptance } from "./growth";
import { dispatchEvent } from "./outbound_webhooks";

/* ------------------------------------------------------------------ */
/* Canonicalization helpers — MUST match whatever the client signed.   */
/* Exported so the testing guide / a client SDK can compute the same   */
/* signature independently.                                            */
/* ------------------------------------------------------------------ */

export function canonicalizeAP2Mandate(mandate: AP2CheckoutCreateRequest["mandate"]): string {
  return JSON.stringify({
    mandate_type: mandate.mandate_type,
    mandate_id: mandate.mandate_id,
    issued_at: mandate.issued_at,
    expires_at: mandate.expires_at,
    max_amount_inr: mandate.max_amount_inr,
    merchant_id: mandate.merchant_id,
    user_id: mandate.user_id,
  });
}

export function canonicalizeNPCIDelegation(
  delegation: NPCIUAPCheckoutCreateRequest["delegation"]
): string {
  return JSON.stringify({
    delegation_id: delegation.delegation_id,
    delegator_vpa: delegation.delegator_vpa,
    delegate_agent_id: delegation.delegate_agent_id,
    delegated_limit_inr: delegation.delegated_limit_inr,
    valid_till: delegation.valid_till,
  });
}

/* ------------------------------------------------------------------ */
/* Cart math shared by all adapters                                    */
/* ------------------------------------------------------------------ */

function cartTotal(lineItems: { sku: string; quantity: number; quoted_unit_price_inr: number }[]) {
  return lineItems.reduce((sum, li) => sum + li.quoted_unit_price_inr * li.quantity, 0);
}

async function validateSkusExist(merchantId: string, lineItems: { sku: string }[]): Promise<string[]> {
  const missing: string[] = [];
  for (const li of lineItems) {
    if (!(await findProduct(merchantId, li.sku))) missing.push(li.sku);
  }
  return missing;
}

/* ------------------------------------------------------------------ */
/* Per-protocol adapters -> CheckoutIntent                             */
/* ------------------------------------------------------------------ */

interface AdapterOutcome {
  intent?: CheckoutIntent;
  rejected?: { httpStatus: number; reason: string };
}

async function adaptACP(merchantId: string, req: ACPCheckoutCreateRequest): Promise<AdapterOutcome> {
  const missing = await validateSkusExist(merchantId, req.line_items);
  if (missing.length) {
    return { rejected: { httpStatus: 400, reason: `Unknown SKU(s): ${missing.join(", ")}` } };
  }

  const intent: CheckoutIntent = {
    intent_id: `intent_acp_${randomUUID()}`,
    source_protocol: "acp",
    buyer_agent: req.buyer_agent,
    line_items: req.line_items,
    currency: req.currency,
    authorized_limit_inr: req.pre_authorized_limit_inr,
    cart_total_inr: cartTotal(req.line_items),
    merchant_reference: req.checkout_session_id,
  };

  await writeAudit(merchantId, {
    intent_id: intent.intent_id,
    step: "MANDATE_VERIFICATION",
    outcome: "PASS",
    actor: "protocol_bridge:acp",
    reason: `ACP checkout session ${req.checkout_session_id} accepted from agent ${req.buyer_agent.agent_id}`,
    detail: { checkout_session_id: req.checkout_session_id },
  });

  return { intent };
}

async function adaptAP2(merchantId: string, req: AP2CheckoutCreateRequest): Promise<AdapterOutcome> {
  const missing = await validateSkusExist(merchantId, req.line_items);
  if (missing.length) {
    return { rejected: { httpStatus: 400, reason: `Unknown SKU(s): ${missing.join(", ")}` } };
  }

  const intentId = `intent_ap2_${randomUUID()}`;
  const canonical = canonicalizeAP2Mandate(req.mandate);
  const sigOk = verifySignature(canonical, req.signed_token);

  if (!sigOk) {
    await writeAudit(merchantId, {
      intent_id: intentId,
      step: "MANDATE_VERIFICATION",
      outcome: "FAIL",
      actor: "protocol_bridge:ap2",
      reason: `AP2 mandate ${req.mandate.mandate_id} failed signature verification`,
      detail: { mandate_id: req.mandate.mandate_id },
    });
    return { rejected: { httpStatus: 401, reason: "AP2 mandate signature verification failed" } };
  }

  if (new Date(req.mandate.expires_at).getTime() < Date.now()) {
    await writeAudit(merchantId, {
      intent_id: intentId,
      step: "MANDATE_VERIFICATION",
      outcome: "FAIL",
      actor: "protocol_bridge:ap2",
      reason: `AP2 mandate ${req.mandate.mandate_id} expired at ${req.mandate.expires_at}`,
      detail: { mandate_id: req.mandate.mandate_id },
    });
    return { rejected: { httpStatus: 401, reason: "AP2 mandate has expired" } };
  }

  await writeAudit(merchantId, {
    intent_id: intentId,
    step: "MANDATE_VERIFICATION",
    outcome: "PASS",
    actor: "protocol_bridge:ap2",
    reason: `AP2 mandate ${req.mandate.mandate_id} signature and expiry verified`,
    detail: { mandate_id: req.mandate.mandate_id, mandate_type: req.mandate.mandate_type },
  });

  const intent: CheckoutIntent = {
    intent_id: intentId,
    source_protocol: "ap2",
    buyer_agent: req.buyer_agent,
    line_items: req.line_items,
    currency: req.currency,
    authorized_limit_inr: req.mandate.max_amount_inr,
    cart_total_inr: cartTotal(req.line_items),
    merchant_reference: req.mandate.mandate_id,
  };

  return { intent };
}

// Replay protection is per-process, not per-merchant — an x402 nonce is a
// payer-issued value and should never be reused regardless of which
// merchant it's presented to.
const seenX402Nonces = new Set<string>();

async function adaptX402(merchantId: string, req: X402CheckoutCreateRequest): Promise<AdapterOutcome> {
  const missing = await validateSkusExist(merchantId, req.line_items);
  if (missing.length) {
    return { rejected: { httpStatus: 400, reason: `Unknown SKU(s): ${missing.join(", ")}` } };
  }

  const intentId = `intent_x402_${randomUUID()}`;

  if (seenX402Nonces.has(req.x402.nonce)) {
    await writeAudit(merchantId, {
      intent_id: intentId,
      step: "MANDATE_VERIFICATION",
      outcome: "FAIL",
      actor: "protocol_bridge:x402",
      reason: `x402 nonce ${req.x402.nonce} has already been used (replay rejected)`,
      detail: { nonce: req.x402.nonce },
    });
    return { rejected: { httpStatus: 409, reason: "x402 payment nonce already used" } };
  }
  seenX402Nonces.add(req.x402.nonce);

  const total = cartTotal(req.line_items);
  if (total > req.x402.max_amount_required_inr) {
    await writeAudit(merchantId, {
      intent_id: intentId,
      step: "MANDATE_VERIFICATION",
      outcome: "FAIL",
      actor: "protocol_bridge:x402",
      reason: `Cart total ₹${total} exceeds x402 max_amount_required_inr ₹${req.x402.max_amount_required_inr}`,
      detail: { cart_total_inr: total, max_amount_required_inr: req.x402.max_amount_required_inr },
    });
    return { rejected: { httpStatus: 402, reason: "Payment amount exceeds x402 authorization" } };
  }

  await writeAudit(merchantId, {
    intent_id: intentId,
    step: "MANDATE_VERIFICATION",
    outcome: "PASS",
    actor: "protocol_bridge:x402",
    reason: `x402 payment header verified for resource ${req.x402.resource} (nonce ${req.x402.nonce})`,
    detail: { network: req.x402.network, payer: req.x402.payer },
  });

  const intent: CheckoutIntent = {
    intent_id: intentId,
    source_protocol: "x402",
    buyer_agent: req.buyer_agent,
    line_items: req.line_items,
    currency: req.currency,
    authorized_limit_inr: req.x402.max_amount_required_inr,
    cart_total_inr: total,
    merchant_reference: req.x402.nonce,
  };

  return { intent };
}

async function adaptNPCIUAP(merchantId: string, req: NPCIUAPCheckoutCreateRequest): Promise<AdapterOutcome> {
  const missing = await validateSkusExist(merchantId, req.line_items);
  if (missing.length) {
    return { rejected: { httpStatus: 400, reason: `Unknown SKU(s): ${missing.join(", ")}` } };
  }

  const intentId = `intent_uap_${randomUUID()}`;
  const canonical = canonicalizeNPCIDelegation(req.delegation);
  const sigOk = verifySignature(canonical, req.delegation.uap_signature);

  if (!sigOk) {
    await writeAudit(merchantId, {
      intent_id: intentId,
      step: "MANDATE_VERIFICATION",
      outcome: "FAIL",
      actor: "protocol_bridge:npci_uap",
      reason: `NPCI UAP delegation ${req.delegation.delegation_id} failed signature verification`,
      detail: { delegation_id: req.delegation.delegation_id },
    });
    return { rejected: { httpStatus: 401, reason: "NPCI UAP delegation signature verification failed" } };
  }

  if (new Date(req.delegation.valid_till).getTime() < Date.now()) {
    await writeAudit(merchantId, {
      intent_id: intentId,
      step: "MANDATE_VERIFICATION",
      outcome: "FAIL",
      actor: "protocol_bridge:npci_uap",
      reason: `NPCI UAP delegation ${req.delegation.delegation_id} expired at ${req.delegation.valid_till}`,
      detail: { delegation_id: req.delegation.delegation_id },
    });
    return { rejected: { httpStatus: 401, reason: "NPCI UAP delegation has expired" } };
  }

  await writeAudit(merchantId, {
    intent_id: intentId,
    step: "MANDATE_VERIFICATION",
    outcome: "PASS",
    actor: "protocol_bridge:npci_uap",
    reason: `NPCI UAP delegated authority ${req.delegation.delegation_id} verified for delegator ${req.delegation.delegator_vpa}`,
    detail: { delegator_vpa: req.delegation.delegator_vpa, delegated_limit_inr: req.delegation.delegated_limit_inr },
  });

  const intent: CheckoutIntent = {
    intent_id: intentId,
    source_protocol: "npci_uap",
    buyer_agent: req.buyer_agent,
    line_items: req.line_items,
    currency: req.currency,
    authorized_limit_inr: req.delegation.delegated_limit_inr,
    cart_total_inr: cartTotal(req.line_items),
    merchant_reference: req.delegation.delegation_id,
  };

  return { intent };
}

/* ------------------------------------------------------------------ */
/* Top-level entry point used by the /agent/v1/checkout route          */
/* ------------------------------------------------------------------ */

export type CheckoutBridgeResult =
  | {
      status: "ORDER_CREATED";
      intent: CheckoutIntent;
      session: CheckoutSessionRecord;
      razorpay_order: unknown;
      audit_id: string;
    }
  | {
      status: "PENDING_HUMAN_APPROVAL";
      intent: CheckoutIntent;
      session: CheckoutSessionRecord;
      approval_id: string;
      audit_id: string;
      reason: string;
    }
  | {
      status: "REJECTED";
      httpStatus: number;
      reason: string;
      audit_id?: string;
      session?: CheckoutSessionRecord;
    };

/**
 * Runs a checkout intent through the full authoritative gate chain and, if
 * approved, creates a real Razorpay test-mode Order. This function never
 * returns a "paid"/"settled" status — creating an order only ever moves a
 * session to ORDER_CREATED. Payment capture is a *separate* fact, only
 * ever set by a verified webhook (webhooks.ts) or an explicitly-labeled
 * simulated Test Lab event — never by this function.
 *
 * `idempotencyKey`, when supplied, guarantees a retried request returns
 * the exact original result instead of creating a second order.
 */
export async function bridgeCheckout(
  merchantId: string,
  req: CheckoutCreateRequest,
  idempotencyKey?: string
): Promise<CheckoutBridgeResult> {
  const cached = await getIdempotentResult<CheckoutBridgeResult>(merchantId, "checkout", idempotencyKey);
  if (cached) {
    const idForAudit = "intent" in cached && cached.intent ? cached.intent.intent_id : "idempotent_replay";
    await writeAudit(merchantId, {
      intent_id: idForAudit,
      step: "IDEMPOTENT_REPLAY",
      outcome: "INFO",
      actor: "protocol_bridge",
      reason: "Retry detected for idempotency key — returning original checkout result, no duplicate order created",
      detail: { idempotency_key: idempotencyKey },
    });
    return cached;
  }

  let outcome: AdapterOutcome;

  switch (req.protocol) {
    case "acp":
      outcome = await adaptACP(merchantId, req);
      break;
    case "ap2":
      outcome = await adaptAP2(merchantId, req);
      break;
    case "x402":
      outcome = await adaptX402(merchantId, req);
      break;
    case "npci_uap":
      outcome = await adaptNPCIUAP(merchantId, req);
      break;
  }

  if (outcome.rejected) {
    return { status: "REJECTED", httpStatus: outcome.rejected.httpStatus, reason: outcome.rejected.reason };
  }

  const intent = outcome.intent!;

  await writeAudit(merchantId, {
    intent_id: intent.intent_id,
    step: "INTENT_RECEIVED",
    outcome: "INFO",
    actor: "protocol_bridge",
    reason: `Checkout intent received via ${intent.source_protocol.toUpperCase()} from agent ${intent.buyer_agent.agent_id} on behalf of user ${intent.buyer_agent.on_behalf_of_user_id}`,
    detail: { line_items: intent.line_items, cart_total_inr: intent.cart_total_inr },
  });

  await writeAudit(merchantId, {
    intent_id: intent.intent_id,
    step: "PROTOCOL_TRANSLATED",
    outcome: "PASS",
    actor: "protocol_bridge",
    reason: `${intent.source_protocol.toUpperCase()} payload normalized into CheckoutIntent and mapped toward a Razorpay Order`,
    detail: { merchant_reference: intent.merchant_reference },
  });

  // Real, observed cross-sell tracking: if this cart contains both a
  // primary SKU and one of its recommended companions, that's a genuine
  // upsell acceptance for the growth engine's live acceptance-rate model.
  await recordAcceptance(merchantId, intent.line_items.map((li) => li.sku), intent.intent_id);

  // Campaign discount — applied BEFORE the guardrail gate evaluates the
  // cart total, so the discount is what's actually checked against
  // authorization/policy. A campaign can only ever reduce spend, and its
  // discount was already validated against the published policy ceiling
  // at creation time (campaigns.ts) — this is the second, live check.
  let appliedCampaignId: string | undefined;
  let appliedDiscountInr = 0;
  for (const li of intent.line_items) {
    const campaign = await findActiveCampaignForSku(merchantId, li.sku);
    if (!campaign) continue;
    const remainingBudget = Math.max(0, campaign.budget_inr - campaign.spent_inr);
    const eligibleDiscount = Math.min(campaign.discount_inr * li.quantity, remainingBudget, intent.cart_total_inr - appliedDiscountInr);
    if (eligibleDiscount <= 0) continue;
    appliedCampaignId = campaign.campaign_id;
    appliedDiscountInr += eligibleDiscount;
    break; // one campaign per checkout, kept simple and unambiguous for audit
  }
  if (appliedCampaignId && appliedDiscountInr > 0) {
    intent.cart_total_inr = Math.max(0, intent.cart_total_inr - appliedDiscountInr);
    await writeAudit(merchantId, {
      intent_id: intent.intent_id,
      step: "CAMPAIGN_APPLIED",
      outcome: "PASS",
      actor: "campaign_engine",
      reason: `Campaign ${appliedCampaignId} discount ₹${appliedDiscountInr} applied — new cart total ₹${intent.cart_total_inr}`,
      detail: { campaign_id: appliedCampaignId, discount_applied_inr: appliedDiscountInr },
    });
  }

  const policy = await getPublishedPolicy(merchantId);
  const paymentMethod = (req as any).payment_method as string | undefined;

  const session = await createSession({
    merchant_id: merchantId,
    buyer_agent_id: intent.buyer_agent.agent_id,
    protocol: intent.source_protocol,
    intent_id: intent.intent_id,
    cart: intent.line_items,
    authorization_inr: intent.authorized_limit_inr,
    policy_version: policy.version,
    final_amount_inr: intent.cart_total_inr,
    currency: intent.currency,
    idempotency_key: idempotencyKey,
    discount_inr: appliedDiscountInr,
    campaign_id: appliedCampaignId,
  });
  await transitionSession(merchantId, session.checkout_session_id, "AUTHORIZED", "protocol_bridge", "Mandate/authorization accepted");
  await transitionSession(merchantId, session.checkout_session_id, "QUOTE_VALIDATED", "protocol_bridge", "Line-item prices accepted as current quote");

  const gate = await runGuardrailGate(merchantId, intent, paymentMethod);

  if (!gate.approved && !gate.requiresHumanApproval) {
    await transitionSession(merchantId, session.checkout_session_id, "BLOCKED", "protocol_bridge",
      `Guardrail policy check failed: ${gate.reasons.join("; ")}`, { policy_decision: "BLOCKED" });
    const result: CheckoutBridgeResult = {
      status: "REJECTED",
      httpStatus: 422,
      reason: `Guardrail policy check failed: ${gate.reasons.join("; ")}`,
      audit_id: gate.auditId,
      session,
    };
    await saveIdempotentResult(merchantId, "checkout", idempotencyKey, result);
    void dispatchEvent(merchantId, "order.blocked", {
      checkout_session_id: session.checkout_session_id,
      intent_id: intent.intent_id,
      cart_total_inr: intent.cart_total_inr,
      reasons: gate.reasons,
    });
    return result;
  }

  if (gate.requiresHumanApproval) {
    await transitionSession(merchantId, session.checkout_session_id, "POLICY_CHECKED", "protocol_bridge", "Policy checks passed, above auto-approve threshold");
    await transitionSession(merchantId, session.checkout_session_id, "REQUIRES_HUMAN", "protocol_bridge",
      `Cart total ₹${intent.cart_total_inr} exceeds auto-approve limit — routing to human approval`,
      { policy_decision: "REQUIRES_HUMAN" });

    const approval = await createApproval(merchantId, {
      checkout_session_id: session.checkout_session_id,
      kind: "limit",
      title: `₹${intent.cart_total_inr} purchase`,
      reason: `Exceeds autonomous limit of ₹${policy.auto_approve_limit_inr}.`,
      amount_inr: intent.cart_total_inr,
    });

    const result: CheckoutBridgeResult = {
      status: "PENDING_HUMAN_APPROVAL",
      intent,
      session,
      approval_id: approval.approval_id,
      audit_id: gate.auditId,
      reason: `Cart total ₹${intent.cart_total_inr} exceeds the auto-approval threshold — a human must approve this payment before settlement.`,
    };
    await saveIdempotentResult(merchantId, "checkout", idempotencyKey, result);
    void dispatchEvent(merchantId, "approval.requested", {
      approval_id: approval.approval_id,
      checkout_session_id: session.checkout_session_id,
      amount_inr: intent.cart_total_inr,
      reason: result.reason,
    });
    return result;
  }

  await transitionSession(merchantId, session.checkout_session_id, "POLICY_CHECKED", "protocol_bridge", "Policy v" + gate.policyVersion + " checks passed");
  await transitionSession(merchantId, session.checkout_session_id, "APPROVED", "protocol_bridge", "Auto-approved within policy", { policy_decision: "APPROVED" });

  // Approved — create the real (test-mode) Razorpay Order. This is order
  // creation only; it does not mean payment has been captured.
  try {
    const order = await createRazorpayOrder({
      amountInr: intent.cart_total_inr,
      currency: intent.currency,
      receipt: intent.intent_id,
      notes: {
        source_protocol: intent.source_protocol,
        buyer_agent_id: intent.buyer_agent.agent_id,
        merchant_reference: intent.merchant_reference,
        checkout_session_id: session.checkout_session_id,
        merchant_id: merchantId,
      },
    });

    await transitionSession(merchantId, session.checkout_session_id, "ORDER_CREATED", "protocol_bridge",
      `Razorpay Order ${(order as any).id} created in test mode`,
      { razorpay_order_id: (order as any).id, order_status: "CREATED" });

    if (appliedCampaignId && appliedDiscountInr > 0) {
      await recordCampaignRedemption(merchantId, appliedCampaignId, appliedDiscountInr);
    }

    const audit = await writeAudit(merchantId, {
      intent_id: intent.intent_id,
      step: "ORDER_CREATED",
      outcome: "PASS",
      actor: "protocol_bridge",
      reason: `Razorpay Order ${(order as any).id} created in test mode for ₹${intent.cart_total_inr}. Payment has NOT been captured yet.`,
      detail: { razorpay_order_id: (order as any).id, checkout_session_id: session.checkout_session_id },
    });

    const result: CheckoutBridgeResult = { status: "ORDER_CREATED", intent, session, razorpay_order: order, audit_id: audit.audit_id };
    await saveIdempotentResult(merchantId, "checkout", idempotencyKey, result);
    void dispatchEvent(merchantId, "order.created", {
      checkout_session_id: session.checkout_session_id,
      razorpay_order_id: (order as any).id,
      cart_total_inr: intent.cart_total_inr,
      currency: intent.currency,
    });
    return result;
  } catch (err: any) {
    await transitionSession(merchantId, session.checkout_session_id, "CANCELLED", "protocol_bridge", `Razorpay order creation failed: ${err?.message ?? String(err)}`);
    const audit = await writeAudit(merchantId, {
      intent_id: intent.intent_id,
      step: "FAILURE",
      outcome: "FAIL",
      actor: "protocol_bridge",
      reason: `Razorpay order creation failed: ${err?.message ?? String(err)}`,
      detail: { error: err?.message ?? String(err) },
    });
    const result: CheckoutBridgeResult = { status: "REJECTED", httpStatus: 502, reason: `Settlement rail error: ${err?.message ?? String(err)}`, audit_id: audit.audit_id, session };
    await saveIdempotentResult(merchantId, "checkout", idempotencyKey, result);
    return result;
  }
}
