/**
 * src/db/inventory_holds.ts — repository layer for `inventory_holds`.
 *
 * Every query here is merchant-scoped except `findExpiredActiveHolds`,
 * which — like `findSessionByOrderOrPaymentGlobal` in db/sessions.ts —
 * is a deliberate, documented cross-tenant scan used only by the
 * background sweep (services/scheduler.ts), which has no single
 * merchant's request context to scope by.
 */

import { and, eq, lt } from "drizzle-orm";
import { db } from "./client";
import { inventoryHolds } from "./schema";

export interface InventoryHoldRow {
  id: string;
  merchantId: string;
  checkoutSessionId: string;
  sku: string;
  quantity: number;
  status: string; // "held" | "released" | "consumed"
  expiresAt: Date;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  createdAt: Date;
}

export async function insertHold(row: Omit<InventoryHoldRow, "createdAt" | "resolvedAt" | "resolutionReason">): Promise<InventoryHoldRow> {
  const [inserted] = await db.insert(inventoryHolds).values({ ...row, resolvedAt: null, resolutionReason: null }).returning();
  return inserted as InventoryHoldRow;
}

/** Total quantity currently held (not yet released/consumed) for one SKU — this is what "available stock" subtracts. */
export async function sumActiveHeldQty(merchantId: string, sku: string): Promise<number> {
  const rows = await db
    .select({ qty: inventoryHolds.quantity })
    .from(inventoryHolds)
    .where(and(eq(inventoryHolds.merchantId, merchantId), eq(inventoryHolds.sku, sku), eq(inventoryHolds.status, "held")));
  return rows.reduce((sum, r) => sum + r.qty, 0);
}

export async function findActiveHoldsForSession(merchantId: string, checkoutSessionId: string): Promise<InventoryHoldRow[]> {
  return (await db
    .select()
    .from(inventoryHolds)
    .where(
      and(
        eq(inventoryHolds.merchantId, merchantId),
        eq(inventoryHolds.checkoutSessionId, checkoutSessionId),
        eq(inventoryHolds.status, "held")
      )
    )) as InventoryHoldRow[];
}

/** Resolves every still-`held` row for a session to `released` or `consumed`. Returns the rows that were actually resolved (empty if none were active). */
export async function resolveHoldsForSession(
  merchantId: string,
  checkoutSessionId: string,
  toStatus: "released" | "consumed",
  reason: string
): Promise<InventoryHoldRow[]> {
  return (await db
    .update(inventoryHolds)
    .set({ status: toStatus, resolvedAt: new Date(), resolutionReason: reason })
    .where(
      and(
        eq(inventoryHolds.merchantId, merchantId),
        eq(inventoryHolds.checkoutSessionId, checkoutSessionId),
        eq(inventoryHolds.status, "held")
      )
    )
    .returning()) as InventoryHoldRow[];
}

/**
 * Cross-tenant: every still-`held` row whose lock timestamp has passed.
 * Used only by the background sweep to find abandoned checkouts across
 * every merchant in one query, mirroring the documented cross-tenant
 * exception in db/sessions.ts#findSessionByOrderOrPaymentGlobal.
 */
export async function findExpiredActiveHolds(now: Date): Promise<InventoryHoldRow[]> {
  return (await db
    .select()
    .from(inventoryHolds)
    .where(and(eq(inventoryHolds.status, "held"), lt(inventoryHolds.expiresAt, now)))) as InventoryHoldRow[];
}

export async function listActiveHoldsForMerchant(merchantId: string): Promise<InventoryHoldRow[]> {
  return (await db
    .select()
    .from(inventoryHolds)
    .where(and(eq(inventoryHolds.merchantId, merchantId), eq(inventoryHolds.status, "held")))) as InventoryHoldRow[];
}
