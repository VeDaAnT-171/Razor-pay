/**
 * src/services/negotiation.ts
 *
 * Module 3: Upsell/Cross-sell & Automated Negotiation Engine —
 * merchant-scoped.
 *
 *  - recommendBundle(): given a cart, returns machine-readable
 *    context-aware bundle recommendations (complementary SKUs).
 *  - evaluateNegotiation(): evaluates a buyer agent's counter-offer
 *    (a requested discount %) against the merchant's per-SKU margin
 *    guardrail (max allowable discount = 10% by default, and never
 *    more than the product's own margin so the merchant can't sell
 *    at a loss).
 */

import { getBundleRulesFor, findProduct } from "./catalog";
import { NegotiationOffer, NegotiationResponse } from "../schema/types";
import { writeAudit } from "./audit_log";
import { getDefaultPolicy } from "../middleware/guardrail_gate";

/* ------------------------------------------------------------------ */
/* Upsell / cross-sell                                                 */
/* ------------------------------------------------------------------ */

export interface BundleRecommendation {
  sku: string;
  name: string;
  price_inr: number;
  reason: string;
}

export async function recommendBundle(merchantId: string, cartSkus: string[]): Promise<BundleRecommendation[]> {
  const alreadyInCart = new Set(cartSkus);
  const recs = new Map<string, BundleRecommendation>();

  for (const sku of cartSkus) {
    const candidates = await getBundleRulesFor(merchantId, sku);
    for (const c of candidates) {
      if (alreadyInCart.has(c.sku) || recs.has(c.sku)) continue;
      const product = await findProduct(merchantId, c.sku);
      if (!product) continue;
      recs.set(c.sku, {
        sku: product.sku,
        name: product.name,
        price_inr: product.price_inr,
        reason: c.reason,
      });
    }
  }

  return Array.from(recs.values());
}

/* ------------------------------------------------------------------ */
/* Automated negotiation                                               */
/* ------------------------------------------------------------------ */

export async function evaluateNegotiation(merchantId: string, offer: NegotiationOffer): Promise<NegotiationResponse> {
  const policy = await getDefaultPolicy(merchantId);
  const product = await findProduct(merchantId, offer.sku);

  if (!product) {
    const response: NegotiationResponse = {
      intent_id: offer.intent_id,
      sku: offer.sku,
      decision: "REJECTED",
      approved_discount_pct: 0,
      final_unit_price_inr: 0,
      reason: `Unknown SKU: ${offer.sku}`,
    };
    await writeAudit(merchantId, {
      intent_id: offer.intent_id,
      step: "NEGOTIATION",
      outcome: "FAIL",
      actor: "negotiation_engine",
      reason: response.reason,
      detail: { sku: offer.sku },
    });
    return response;
  }

  // Never negotiate away more margin than the merchant actually has, and
  // never more than the platform-wide guardrail (default 10%).
  const ceilingPct = Math.min(policy.max_auto_discount_pct, product.margin_pct);

  let decision: NegotiationResponse["decision"];
  let approvedPct: number;
  let reason: string;

  if (offer.requested_discount_pct <= 0) {
    decision = "REJECTED";
    approvedPct = 0;
    reason = "Requested discount must be greater than 0%.";
  } else if (offer.requested_discount_pct <= ceilingPct) {
    decision = "ACCEPTED";
    approvedPct = offer.requested_discount_pct;
    reason = `Requested ${offer.requested_discount_pct}% is within the margin guardrail (max ${ceilingPct}% for this SKU).`;
  } else {
    decision = "COUNTERED";
    approvedPct = ceilingPct;
    reason = `Requested ${offer.requested_discount_pct}% exceeds the margin guardrail — countering at the maximum allowable ${ceilingPct}%.`;
  }

  const finalPrice = Number((product.price_inr * (1 - approvedPct / 100)).toFixed(2));

  const response: NegotiationResponse = {
    intent_id: offer.intent_id,
    sku: offer.sku,
    decision,
    approved_discount_pct: approvedPct,
    final_unit_price_inr: finalPrice,
    reason,
  };

  await writeAudit(merchantId, {
    intent_id: offer.intent_id,
    step: "NEGOTIATION",
    outcome: decision === "REJECTED" ? "FAIL" : "PASS",
    actor: "negotiation_engine",
    reason,
    detail: {
      sku: offer.sku,
      requested_discount_pct: offer.requested_discount_pct,
      approved_discount_pct: approvedPct,
      product_margin_pct: product.margin_pct,
      platform_max_discount_pct: policy.max_auto_discount_pct,
      final_unit_price_inr: finalPrice,
    },
  });

  return response;
}
