/**
 * src/services/campaigns.ts
 *
 * Spec section 22 / Phase 8: campaigns targeted at AI buyer intent — now
 * merchant-scoped and Postgres-backed.
 *
 * This is intentionally NOT an AI-generated-analytics fantasy. It is a
 * real campaign store with real validation: a campaign's discount and
 * per-order cap are checked against the *same* published PolicyV2 that
 * gates every checkout (see policy_store.ts / guardrail_gate.ts) — a
 * campaign can never grant more discount than the merchant's own policy
 * ceiling allows, and creation is rejected (not silently clamped) when it
 * tries to.
 *
 * Campaign measurement (redemptions, spend) is tracked from real checkout
 * sessions that reference a campaign_id — see recordCampaignRedemption(),
 * called from protocol_bridge.ts, using an atomic SQL increment so
 * concurrent redemptions can't under-count spend.
 */

import { randomUUID } from "crypto";
import { getPublishedPolicy } from "./policy_store";
import { findProduct } from "./catalog";
import * as repo from "../db/campaigns";

export interface Campaign {
  campaign_id: string;
  name: string;
  trigger_intent: string;
  product_skus: string[];
  discount_inr: number;
  max_discount_pct: number;
  budget_inr: number;
  spent_inr: number;
  daily_order_limit: number;
  redemptions: number;
  status: "draft" | "active" | "paused" | "budget_exhausted";
  created_at: string;
  activated_at?: string;
}

function toDomain(row: repo.CampaignRow): Campaign {
  return {
    campaign_id: row.id,
    name: row.name,
    trigger_intent: row.triggerIntent,
    product_skus: row.productSkus as string[],
    discount_inr: row.discountInr,
    max_discount_pct: row.maxDiscountPct,
    budget_inr: row.budgetInr,
    spent_inr: row.spentInr,
    daily_order_limit: row.dailyOrderLimit,
    redemptions: row.redemptions,
    status: row.status as Campaign["status"],
    created_at: row.createdAt.toISOString(),
    activated_at: row.activatedAt ? row.activatedAt.toISOString() : undefined,
  };
}

export interface CreateCampaignInput {
  name: string;
  trigger_intent: string;
  product_skus: string[];
  discount_inr: number;
  budget_inr: number;
  daily_order_limit?: number;
}

export type CreateCampaignResult =
  | { ok: true; campaign: Campaign }
  | { ok: false; httpStatus: number; error: string };

export async function createCampaign(merchantId: string, input: CreateCampaignInput): Promise<CreateCampaignResult> {
  const policy = await getPublishedPolicy(merchantId);

  if (!input.name || !input.product_skus?.length) {
    return { ok: false, httpStatus: 400, error: "name and at least one product_sku are required" };
  }

  const products = await Promise.all(input.product_skus.map((sku) => findProduct(merchantId, sku)));
  const unknownSkus = input.product_skus.filter((_, i) => !products[i]);
  if (unknownSkus.length > 0) {
    return { ok: false, httpStatus: 400, error: `Unknown SKU(s): ${unknownSkus.join(", ")}` };
  }
  if (input.discount_inr <= 0 || input.budget_inr <= 0) {
    return { ok: false, httpStatus: 400, error: "discount_inr and budget_inr must be positive" };
  }

  // The critical guardrail: a campaign's discount can never exceed what the
  // merchant's own published policy allows for the cheapest targeted SKU.
  const cheapestTargeted = Math.min(...products.map((p) => p!.price_inr));
  const discountPct = (input.discount_inr / cheapestTargeted) * 100;
  if (discountPct > policy.max_auto_discount_pct) {
    return {
      ok: false,
      httpStatus: 422,
      error: `Discount ₹${input.discount_inr} is ${discountPct.toFixed(1)}% of the cheapest targeted product (₹${cheapestTargeted}), exceeding Policy v${policy.version}'s ${policy.max_auto_discount_pct}% cap. Lower the discount or raise the discount policy first.`,
    };
  }
  if (policy.max_absolute_discount_inr !== undefined && input.discount_inr > policy.max_absolute_discount_inr) {
    return {
      ok: false,
      httpStatus: 422,
      error: `Discount ₹${input.discount_inr} exceeds Policy v${policy.version}'s absolute discount ceiling of ₹${policy.max_absolute_discount_inr}.`,
    };
  }

  const id = `camp_${randomUUID().slice(0, 8)}`;
  const row = await repo.insertCampaign({
    id,
    merchantId,
    name: input.name,
    triggerIntent: input.trigger_intent,
    productSkus: input.product_skus,
    discountInr: input.discount_inr,
    maxDiscountPct: Math.round(discountPct * 10) / 10,
    budgetInr: input.budget_inr,
    spentInr: 0,
    dailyOrderLimit: input.daily_order_limit ?? 50,
    redemptions: 0,
    status: "draft",
    activatedAt: null,
  });
  return { ok: true, campaign: toDomain(row) };
}

export async function activateCampaign(merchantId: string, campaignId: string): Promise<CreateCampaignResult> {
  const row = await repo.updateCampaign(merchantId, campaignId, { status: "active", activatedAt: new Date() });
  if (!row) return { ok: false, httpStatus: 404, error: "Unknown campaign_id" };
  return { ok: true, campaign: toDomain(row) };
}

export async function pauseCampaign(merchantId: string, campaignId: string): Promise<CreateCampaignResult> {
  const row = await repo.updateCampaign(merchantId, campaignId, { status: "paused" });
  if (!row) return { ok: false, httpStatus: 404, error: "Unknown campaign_id" };
  return { ok: true, campaign: toDomain(row) };
}

export async function listCampaigns(merchantId: string): Promise<Campaign[]> {
  const rows = await repo.listCampaigns(merchantId);
  return rows.map(toDomain);
}

export async function getCampaign(merchantId: string, campaignId: string): Promise<Campaign | undefined> {
  const row = await repo.findCampaign(merchantId, campaignId);
  return row ? toDomain(row) : undefined;
}

/** Finds an active campaign covering a SKU with remaining budget, for the checkout flow to apply. */
export async function findActiveCampaignForSku(merchantId: string, sku: string): Promise<Campaign | undefined> {
  const rows = await repo.listActiveCampaignsWithBudget(merchantId);
  const match = rows.find((c) => (c.productSkus as string[]).includes(sku) && c.spentInr < c.budgetInr);
  return match ? toDomain(match) : undefined;
}

/** Called by the checkout flow once an order referencing a campaign is created. Atomic — see db/campaigns.ts. */
export async function recordCampaignRedemption(merchantId: string, campaignId: string, discountAppliedInr: number): Promise<void> {
  await repo.recordRedemption(merchantId, campaignId, discountAppliedInr);
}
