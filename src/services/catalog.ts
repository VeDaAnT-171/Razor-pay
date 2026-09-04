/**
 * src/services/catalog.ts
 *
 * Merchant-scoped catalog service — the async, Postgres-backed replacement
 * for the old single global `CATALOG` array. Keeps the same `Product`
 * shape (snake_case price_inr etc.) the rest of the codebase already uses,
 * so callers mostly just gain a `merchantId` first argument and an `await`.
 */

import { Product, DEFAULT_CATALOG, DEFAULT_BUNDLE_RULES } from "../data/catalog";
import * as repo from "../db/catalog";

function toProduct(row: repo.ProductRow): Product {
  return {
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    mcc: row.mcc,
    price_inr: row.priceInr,
    inventory_count: row.inventoryCount,
    margin_pct: row.marginPct,
    image_url: row.imageUrl,
    driftEnabled: row.driftEnabled,
  };
}

/** Called once, at merchant signup — copies the demo catalog + bundle rules into this tenant's own rows. */
export async function seedMerchantCatalog(merchantId: string): Promise<void> {
  await repo.insertProducts(
    merchantId,
    DEFAULT_CATALOG.map((p) => ({
      sku: p.sku,
      name: p.name,
      description: p.description,
      category: p.category,
      mcc: p.mcc,
      priceInr: p.price_inr,
      inventoryCount: p.inventory_count,
      marginPct: p.margin_pct,
      imageUrl: p.image_url,
      driftEnabled: !!p.driftEnabled,
    }))
  );

  const rules: { primarySku: string; companionSku: string; reason: string }[] = [];
  for (const [primarySku, candidates] of Object.entries(DEFAULT_BUNDLE_RULES)) {
    for (const c of candidates) rules.push({ primarySku, companionSku: c.sku, reason: c.reason });
  }
  await repo.insertBundleRules(merchantId, rules);
}

export async function listCatalog(merchantId: string): Promise<Product[]> {
  const rows = await repo.listProducts(merchantId);
  return rows.map(toProduct);
}

export async function findProduct(merchantId: string, sku: string): Promise<Product | undefined> {
  const row = await repo.findProductBySku(merchantId, sku);
  return row ? toProduct(row) : undefined;
}

export interface SearchCatalogArgs {
  query?: string;
  category?: string;
  max_price_inr?: number;
}

export async function searchCatalog(merchantId: string, args: SearchCatalogArgs = {}): Promise<Product[]> {
  const { query, category, max_price_inr } = args;
  const all = await listCatalog(merchantId);
  return all.filter((p) => {
    if (query) {
      const haystack = `${p.name} ${p.description} ${p.category}`.toLowerCase();
      if (!haystack.includes(query.toLowerCase())) return false;
    }
    if (category && !p.category.toLowerCase().includes(category.toLowerCase())) return false;
    if (typeof max_price_inr === "number" && p.price_inr > max_price_inr) return false;
    return true;
  });
}

/** Used only by the price-drift / mandate-breach demo route to reprice a SKU mid-flight, then restore it. */
export async function forcePriceDrift(merchantId: string, sku: string, newPriceInr: number): Promise<boolean> {
  const existing = await repo.findProductBySku(merchantId, sku);
  if (!existing) return false;
  await repo.updateProductPrice(merchantId, sku, newPriceInr);
  return true;
}

export interface BundleCandidate {
  sku: string;
  reason: string;
}

export async function getBundleRulesFor(merchantId: string, primarySku: string): Promise<BundleCandidate[]> {
  const rows = await repo.listBundleRulesForSku(merchantId, primarySku);
  return rows.map((r) => ({ sku: r.companionSku, reason: r.reason }));
}

/** All bundle pairs for this merchant, shaped like the old global BUNDLE_RULES record. */
export async function getAllBundleRules(merchantId: string): Promise<Record<string, BundleCandidate[]>> {
  const rows = await repo.listAllBundleRules(merchantId);
  const out: Record<string, BundleCandidate[]> = {};
  for (const r of rows) {
    (out[r.primarySku] ??= []).push({ sku: r.companionSku, reason: r.reason });
  }
  return out;
}
