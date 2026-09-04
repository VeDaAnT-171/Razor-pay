/**
 * src/services/growth.ts
 *
 * Spec section 21 / Phase 7: Upsell & Cross-sell Agent, plus the
 * "Revenue Opportunities" surface from spec section 23 that feeds the
 * Campaign Orchestrator candidate offers. Merchant-scoped and
 * Postgres-backed.
 *
 * This is deliberately NOT a fabricated-analytics page. Every number is
 * either:
 *   - LIVE       computed from real impressions/acceptances observed
 *                 across real /agent/v1/cart/recommendations calls and
 *                 real checkouts, once enough samples exist, or
 *   - ESTIMATED  a baseline heuristic derived from real catalog data
 *                 (price, margin) — clearly labeled as an estimate,
 *                 continuously blended toward the observed rate as real
 *                 samples accumulate (a simple additive-smoothing model,
 *                 not a random guess).
 *
 * "Impression" = this companion SKU was surfaced as a recommendation for
 * a cart containing the primary SKU (recordImpressions, called from the
 * cart/recommendations route). "Acceptance" = a real checkout's cart
 * ended up containing BOTH skus (recordAcceptance, called from
 * protocol_bridge.ts for every checkout intent, live or demo-triggered).
 */

import { getAllBundleRules, getBundleRulesFor, findProduct } from "./catalog";
import { writeAudit } from "./audit_log";
import { findActiveCampaignForSku } from "./campaigns";
import { getPublishedPolicy } from "./policy_store";
import { GrowthOpportunity, GrowthRecommendation } from "../schema/types";
import * as repo from "../db/growth";

/** Called whenever recommendations are actually surfaced to a buyer (cart/recommendations route). */
export async function recordImpressions(merchantId: string, cartSkus: string[]): Promise<void> {
  const inCart = new Set(cartSkus);
  for (const sku of cartSkus) {
    const candidates = await getBundleRulesFor(merchantId, sku);
    for (const c of candidates) {
      if (inCart.has(c.sku)) continue; // already in cart — not a fresh impression
      await repo.incrementImpressions(merchantId, sku, c.sku);
    }
  }
}

/**
 * Called for every real checkout intent. If the cart contains both a
 * primary SKU and one of its recommended companions, that's a real,
 * observed upsell acceptance — audited, not just counted silently.
 */
export async function recordAcceptance(merchantId: string, cartSkus: string[], intentId?: string): Promise<void> {
  const inCart = new Set(cartSkus);
  for (const sku of cartSkus) {
    const candidates = await getBundleRulesFor(merchantId, sku);
    for (const c of candidates) {
      if (!inCart.has(c.sku)) continue;
      await repo.incrementAcceptances(merchantId, sku, c.sku);
      if (intentId) {
        const primary = await findProduct(merchantId, sku);
        const companion = await findProduct(merchantId, c.sku);
        await writeAudit(merchantId, {
          intent_id: intentId,
          step: "RECOMMENDATION",
          outcome: "PASS",
          actor: "growth_engine",
          reason: `Cross-sell accepted: ${companion?.name ?? c.sku} added alongside ${primary?.name ?? sku}`,
          detail: { primary_sku: sku, companion_sku: c.sku },
        });
      }
    }
  }
}

export async function toggleRecommendation(merchantId: string, primarySku: string, companionSku: string, enabled: boolean): Promise<boolean> {
  await repo.setDisabled(merchantId, primarySku, companionSku, !enabled);
  return enabled;
}

/* ------------------------------------------------------------------ */
/* Baseline (ESTIMATED) model — used until real samples accumulate      */
/* ------------------------------------------------------------------ */

const MIN_LIVE_SAMPLES = 8; // impressions needed before a rate counts as LIVE
const PRIOR_WEIGHT = 6; // how strongly the baseline pulls a thin sample toward it
const ASSUMED_MONTHLY_INTENT_VOLUME = 150; // stated assumption: conversations/carts touching the primary SKU per month

function baselineAcceptancePct(companionMarginPct: number): number {
  // Higher-margin accessories are the ones merchants most want to push, and
  // in practice attach better because they're priced as adds, not upgrades.
  // Deliberately conservative (10%-35% band).
  return Math.min(35, Math.max(10, 15 + companionMarginPct / 5));
}

async function buildRecommendation(merchantId: string, primarySku: string, companionSku: string, reason: string): Promise<GrowthRecommendation | null> {
  const primary = await findProduct(merchantId, primarySku);
  const companion = await findProduct(merchantId, companionSku);
  if (!primary || !companion) return null;

  const ledger = await repo.findLedgerEntry(merchantId, primarySku, companionSku);
  const imp = ledger?.impressions ?? 0;
  const acc = ledger?.acceptances ?? 0;
  const disabled = ledger?.disabled ?? false;
  const baseline = baselineAcceptancePct(companion.margin_pct);

  const isLive = imp >= MIN_LIVE_SAMPLES;
  // Additive smoothing: blends observed acceptances toward the baseline
  // until enough real samples exist, then converges on the observed rate.
  const blendedRatePct = Math.round(
    (100 * (acc + (baseline / 100) * PRIOR_WEIGHT)) / (imp + PRIOR_WEIGHT)
  );

  const expectedIncrementalRevenueInr = Math.round(
    (blendedRatePct / 100) * ASSUMED_MONTHLY_INTENT_VOLUME * companion.price_inr
  );
  const expectedConversionImpactPct = Math.round(blendedRatePct * 0.15 * 10) / 10;
  const expectedMarginInr = Math.round(companion.price_inr * (companion.margin_pct / 100));

  return {
    primary_sku: primarySku,
    primary_name: primary.name,
    companion_sku: companionSku,
    companion_name: companion.name,
    companion_price_inr: companion.price_inr,
    reason,
    enabled: !disabled,
    confidence: isLive ? "LIVE" : "ESTIMATED",
    impressions: imp,
    acceptances: acc,
    acceptance_rate_pct: blendedRatePct,
    expected_incremental_revenue_inr: expectedIncrementalRevenueInr,
    expected_conversion_impact_pct: expectedConversionImpactPct,
    expected_margin_inr: expectedMarginInr,
    inventory_available: companion.inventory_count,
    inventory_note: companion.inventory_count < 10 ? `Only ${companion.inventory_count} left — recommend cautiously` : `${companion.inventory_count} in stock`,
  };
}

/**
 * Returns enriched recommendations. If `cartSkus` is given, only companions
 * not already in that cart are returned (the live "what should I add?"
 * case). If omitted, every bundle-rule pairing in the catalog is returned
 * (the merchant-facing Upsell & Cross-sell dashboard).
 */
export async function getRecommendations(merchantId: string, cartSkus?: string[]): Promise<GrowthRecommendation[]> {
  const inCart = new Set(cartSkus ?? []);
  const pairs: { primarySku: string; companionSku: string; reason: string }[] = [];

  if (cartSkus) {
    for (const sku of cartSkus) {
      const candidates = await getBundleRulesFor(merchantId, sku);
      for (const c of candidates) pairs.push({ primarySku: sku, companionSku: c.sku, reason: c.reason });
    }
  } else {
    const all = await getAllBundleRules(merchantId);
    for (const [primarySku, candidates] of Object.entries(all)) {
      for (const c of candidates) pairs.push({ primarySku, companionSku: c.sku, reason: c.reason });
    }
  }

  const results: GrowthRecommendation[] = [];
  for (const p of pairs) {
    if (cartSkus && inCart.has(p.companionSku)) continue;
    const rec = await buildRecommendation(merchantId, p.primarySku, p.companionSku, p.reason);
    if (rec && rec.enabled) results.push(rec);
    else if (rec && !cartSkus) results.push(rec); // dashboard view shows disabled ones too, greyed out by the client
  }
  return results.sort((a, b) => b.expected_incremental_revenue_inr - a.expected_incremental_revenue_inr);
}

/* ------------------------------------------------------------------ */
/* Opportunity detection — the "Revenue Opportunities" feed             */
/* ------------------------------------------------------------------ */

const OPPORTUNITY_THRESHOLD_PCT = 15;

export async function getOpportunities(merchantId: string): Promise<GrowthOpportunity[]> {
  const policy = await getPublishedPolicy(merchantId);
  const allRecs = await getRecommendations(merchantId);
  const recs = allRecs.filter((r) => r.enabled && r.acceptance_rate_pct >= OPPORTUNITY_THRESHOLD_PCT);

  const opportunities: GrowthOpportunity[] = [];
  for (const r of recs) {
    const [activeOnCompanion, activeOnPrimary, companion, primary] = await Promise.all([
      findActiveCampaignForSku(merchantId, r.companion_sku),
      findActiveCampaignForSku(merchantId, r.primary_sku),
      findProduct(merchantId, r.companion_sku),
      findProduct(merchantId, r.primary_sku),
    ]);
    const alreadyCovered = !!activeOnCompanion || !!activeOnPrimary;
    if (alreadyCovered || !companion || !primary) continue;

    // Suggest a discount guaranteed to clear the merchant's own published
    // policy ceiling — campaigns.ts validates against the CHEAPEST of the
    // targeted SKUs, so this must match that exact rule, not just the
    // companion's price, or "Create bundle" can still bounce.
    const cheapestTargeted = Math.min(primary.price_inr, companion.price_inr);
    const maxByPct = cheapestTargeted * (policy.max_auto_discount_pct / 100);
    const maxByAbs = policy.max_absolute_discount_inr ?? maxByPct;
    const ceiling = Math.min(maxByPct, maxByAbs);
    const suggestedDiscount = Math.max(1, Math.min(Math.round(ceiling * 0.8), Math.floor(ceiling)));

    opportunities.push({
      opportunity_id: `opp_${r.primary_sku}_${r.companion_sku}`,
      primary_sku: r.primary_sku,
      companion_sku: r.companion_sku,
      headline: `${r.acceptance_rate_pct}% of ${r.primary_name} carts also want ${r.companion_name}`,
      evidence:
        r.confidence === "LIVE"
          ? `Observed across ${r.impressions} real recommendation${r.impressions === 1 ? "" : "s"} (${r.acceptances} accepted).`
          : `Estimated from category margin baseline — only ${r.impressions} sample${r.impressions === 1 ? "" : "s"} observed so far, not yet enough for a live rate.`,
      confidence: r.confidence,
      potential_monthly_revenue_inr: r.expected_incremental_revenue_inr,
      already_has_active_campaign: alreadyCovered,
      suggested_campaign: {
        name: `${r.companion_name} bundle`,
        trigger_intent: `Buyer intent mentions ${r.primary_name.toLowerCase()} together with a related need`,
        product_skus: [r.primary_sku, r.companion_sku],
        discount_inr: suggestedDiscount,
        budget_inr: Math.max(1000, Math.round(r.expected_incremental_revenue_inr * 0.3)),
        daily_order_limit: 10,
      },
    });
  }

  return opportunities.sort((a, b) => b.potential_monthly_revenue_inr - a.potential_monthly_revenue_inr).slice(0, 4);
}

/** Test/demo helper. */
export async function resetGrowthForTests(merchantId: string): Promise<void> {
  await repo.clearForMerchant(merchantId);
}
