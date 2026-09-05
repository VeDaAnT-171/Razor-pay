/**
 * src/services/inventory.ts
 *
 * Reservation holds against real stock, with lock timestamps — the
 * "Failure & Rollback" half of the hackathon bar. A checkout committing
 * to buy N units of a SKU places a *hold* (this file), not a permanent
 * decrement: the sale only becomes permanent (`consumeHoldsForSession`)
 * once a payment is genuinely captured, and every other outcome
 * (blocked, rejected, cancelled, or simply abandoned past its lock
 * timestamp) releases the hold back to the pool
 * (`releaseHoldsForSession`, or the background sweep in
 * services/scheduler.ts for the "nobody ever paid" case).
 *
 * Available quantity is always computed live as
 * `inventory_count - SUM(active holds)` — there is no cached "reserved"
 * counter that could drift out of sync with the real hold rows.
 */

import { randomUUID } from "crypto";
import { findProductBySku, decrementInventory } from "../db/catalog";
import * as repo from "../db/inventory_holds";
import { writeAudit } from "./audit_log";

/** Default lock duration for a fresh hold — how long a checkout has to actually pay before its held stock is released back to the pool. */
export const DEFAULT_HOLD_TTL_SEC = Number(process.env.INVENTORY_HOLD_TTL_SEC ?? 900); // 15 minutes

export interface CartLine {
  sku: string;
  quantity: number;
}

export async function getAvailableQuantity(merchantId: string, sku: string): Promise<number> {
  const product = await findProductBySku(merchantId, sku);
  if (!product) return 0;
  const held = await repo.sumActiveHeldQty(merchantId, sku);
  return Math.max(0, product.inventoryCount - held);
}

export type PlaceHoldsResult =
  | { ok: true; expires_at: string }
  | { ok: false; reason: string; shortages: { sku: string; requested: number; available: number }[] };

/**
 * Places a hold for every line item in one checkout's cart, or none at
 * all — a cart is either fully reservable right now or the checkout is
 * refused before it ever reaches the payment rail. Not a single SQL
 * transaction across rows (this codebase's repositories are all
 * single-statement, per its established style), but check-then-insert
 * per line is enough to catch the common demo/small-scale case; a
 * production hardening pass would wrap this in a serializable DB
 * transaction — see README "Known limitations".
 */
export async function placeHoldsForCart(
  merchantId: string,
  checkoutSessionId: string,
  intentId: string,
  cart: CartLine[],
  ttlSec: number = DEFAULT_HOLD_TTL_SEC
): Promise<PlaceHoldsResult> {
  const shortages: { sku: string; requested: number; available: number }[] = [];
  for (const line of cart) {
    const available = await getAvailableQuantity(merchantId, line.sku);
    if (available < line.quantity) shortages.push({ sku: line.sku, requested: line.quantity, available });
  }

  if (shortages.length > 0) {
    await writeAudit(merchantId, {
      intent_id: intentId,
      step: "INVENTORY_HELD",
      outcome: "FAIL",
      actor: "inventory",
      reason: `Could not place inventory holds — insufficient stock for ${shortages.map((s) => `${s.sku} (wanted ${s.requested}, ${s.available} available)`).join(", ")}`,
      detail: { checkout_session_id: checkoutSessionId, shortages },
    });
    return { ok: false, reason: "OUT_OF_STOCK", shortages };
  }

  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  for (const line of cart) {
    await repo.insertHold({
      id: `hold_${randomUUID()}`,
      merchantId,
      checkoutSessionId,
      sku: line.sku,
      quantity: line.quantity,
      status: "held",
      expiresAt,
    });
  }

  await writeAudit(merchantId, {
    intent_id: intentId,
    step: "INVENTORY_HELD",
    outcome: "PASS",
    actor: "inventory",
    reason: `Reserved ${cart.map((l) => `${l.quantity}x ${l.sku}`).join(", ")} until ${expiresAt.toISOString()} — released automatically if this checkout doesn't complete by then`,
    detail: { checkout_session_id: checkoutSessionId, cart, expires_at: expiresAt.toISOString(), ttl_sec: ttlSec },
  });

  return { ok: true, expires_at: expiresAt.toISOString() };
}

/** Releases every active hold for a session back to the pool — checkout was blocked, rejected, cancelled, or timed out. Safe to call even if no holds are active (no-op, no audit spam). */
export async function releaseHoldsForSession(merchantId: string, checkoutSessionId: string, reason: string, intentId?: string): Promise<void> {
  const resolved = await repo.resolveHoldsForSession(merchantId, checkoutSessionId, "released", reason);
  if (resolved.length === 0) return;
  await writeAudit(merchantId, {
    intent_id: intentId ?? checkoutSessionId,
    step: "INVENTORY_RELEASED",
    outcome: "INFO",
    actor: "inventory",
    reason: `Released ${resolved.map((h) => `${h.quantity}x ${h.sku}`).join(", ")} back to available stock — ${reason}`,
    detail: { checkout_session_id: checkoutSessionId, released: resolved.map((h) => ({ sku: h.sku, quantity: h.quantity })) },
  });
}

/** Converts every active hold for a session into a real, permanent stock decrement — called only once a payment has genuinely captured. */
export async function consumeHoldsForSession(merchantId: string, checkoutSessionId: string, intentId?: string): Promise<void> {
  const resolved = await repo.resolveHoldsForSession(merchantId, checkoutSessionId, "consumed", "Payment captured — hold converted to a permanent sale");
  if (resolved.length === 0) return;
  for (const hold of resolved) {
    await decrementInventory(merchantId, hold.sku, hold.quantity);
  }
  await writeAudit(merchantId, {
    intent_id: intentId ?? checkoutSessionId,
    step: "INVENTORY_CONSUMED",
    outcome: "PASS",
    actor: "inventory",
    reason: `Payment captured — permanently decremented ${resolved.map((h) => `${h.quantity}x ${h.sku}`).join(", ")}`,
    detail: { checkout_session_id: checkoutSessionId, consumed: resolved.map((h) => ({ sku: h.sku, quantity: h.quantity })) },
  });
}

export async function listActiveHolds(merchantId: string) {
  return repo.listActiveHoldsForMerchant(merchantId);
}

/**
 * Cross-tenant sweep: every hold still `held` past its lock timestamp,
 * grouped back to its session, released in one shot per session. Called
 * only by services/scheduler.ts.
 */
export async function releaseAllExpiredHolds(): Promise<{ sessionsAffected: string[] }> {
  const expired = await repo.findExpiredActiveHolds(new Date());
  const bySession = new Map<string, repo.InventoryHoldRow[]>();
  for (const hold of expired) {
    const key = `${hold.merchantId}::${hold.checkoutSessionId}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key)!.push(hold);
  }
  const sessionsAffected: string[] = [];
  for (const [key, holds] of bySession) {
    const [merchantId, checkoutSessionId] = key.split("::");
    await releaseHoldsForSession(merchantId, checkoutSessionId, "Hold expired — checkout was abandoned before payment completed");
    sessionsAffected.push(checkoutSessionId);
  }
  return { sessionsAffected };
}
