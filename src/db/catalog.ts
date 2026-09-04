/**
 * src/db/catalog.ts — repository layer for `products` and `bundle_rules`.
 * Every query is scoped by merchantId; nothing here trusts a caller who
 * omitted it (there is no "list all products" query without one).
 */

import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { products, bundleRules } from "./schema";

export interface ProductRow {
  id: string;
  merchantId: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  mcc: string;
  priceInr: number;
  inventoryCount: number;
  marginPct: number;
  imageUrl: string;
  driftEnabled: boolean;
}

export async function insertProducts(
  merchantId: string,
  items: Omit<ProductRow, "id" | "merchantId">[]
): Promise<void> {
  if (items.length === 0) return;
  await db.insert(products).values(
    items.map((p) => ({ id: `prod_${randomUUID()}`, merchantId, ...p }))
  );
}

export async function listProducts(merchantId: string): Promise<ProductRow[]> {
  return (await db.select().from(products).where(eq(products.merchantId, merchantId))) as ProductRow[];
}

export async function findProductBySku(merchantId: string, sku: string): Promise<ProductRow | undefined> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.merchantId, merchantId), eq(products.sku, sku)))
    .limit(1);
  return rows[0] as ProductRow | undefined;
}

export async function updateProductPrice(merchantId: string, sku: string, priceInr: number): Promise<void> {
  await db
    .update(products)
    .set({ priceInr, updatedAt: new Date() })
    .where(and(eq(products.merchantId, merchantId), eq(products.sku, sku)));
}

export interface BundleRuleRow {
  merchantId: string;
  primarySku: string;
  companionSku: string;
  reason: string;
}

export async function insertBundleRules(merchantId: string, rules: Omit<BundleRuleRow, "merchantId">[]): Promise<void> {
  if (rules.length === 0) return;
  await db.insert(bundleRules).values(
    rules.map((r) => ({ id: `bndl_${randomUUID()}`, merchantId, ...r }))
  );
}

export async function listBundleRulesForSku(merchantId: string, primarySku: string): Promise<BundleRuleRow[]> {
  return (await db
    .select()
    .from(bundleRules)
    .where(and(eq(bundleRules.merchantId, merchantId), eq(bundleRules.primarySku, primarySku)))) as BundleRuleRow[];
}

export async function listAllBundleRules(merchantId: string): Promise<BundleRuleRow[]> {
  return (await db.select().from(bundleRules).where(eq(bundleRules.merchantId, merchantId))) as BundleRuleRow[];
}
