/**
 * src/db/growth.ts — repository layer for `growth_ledger` (the
 * impression/acceptance counters behind the upsell/cross-sell agent).
 */

import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./client";
import { growthLedger } from "./schema";

export interface GrowthLedgerRow {
  id: string;
  merchantId: string;
  primarySku: string;
  companionSku: string;
  impressions: number;
  acceptances: number;
  disabled: boolean;
}

async function ensureRow(merchantId: string, primarySku: string, companionSku: string): Promise<void> {
  await db
    .insert(growthLedger)
    .values({ id: randomUUID(), merchantId, primarySku, companionSku, impressions: 0, acceptances: 0, disabled: false })
    .onConflictDoNothing({ target: [growthLedger.merchantId, growthLedger.primarySku, growthLedger.companionSku] });
}

/** Atomic increment — safe under concurrent recordImpressions/recordAcceptance calls. */
export async function incrementImpressions(merchantId: string, primarySku: string, companionSku: string): Promise<void> {
  await ensureRow(merchantId, primarySku, companionSku);
  await db
    .update(growthLedger)
    .set({ impressions: sql`${growthLedger.impressions} + 1` })
    .where(
      and(
        eq(growthLedger.merchantId, merchantId),
        eq(growthLedger.primarySku, primarySku),
        eq(growthLedger.companionSku, companionSku)
      )
    );
}

/** Atomic increment of acceptances, and — matching the original ledger-consistency rule — impressions is raised to at least acceptances so the rate can never read above 100%. */
export async function incrementAcceptances(merchantId: string, primarySku: string, companionSku: string): Promise<void> {
  await ensureRow(merchantId, primarySku, companionSku);
  await db
    .update(growthLedger)
    .set({
      acceptances: sql`${growthLedger.acceptances} + 1`,
      impressions: sql`GREATEST(${growthLedger.impressions}, ${growthLedger.acceptances} + 1)`,
    })
    .where(
      and(
        eq(growthLedger.merchantId, merchantId),
        eq(growthLedger.primarySku, primarySku),
        eq(growthLedger.companionSku, companionSku)
      )
    );
}

export async function setDisabled(merchantId: string, primarySku: string, companionSku: string, disabled: boolean): Promise<void> {
  await ensureRow(merchantId, primarySku, companionSku);
  await db
    .update(growthLedger)
    .set({ disabled })
    .where(
      and(
        eq(growthLedger.merchantId, merchantId),
        eq(growthLedger.primarySku, primarySku),
        eq(growthLedger.companionSku, companionSku)
      )
    );
}

export async function findLedgerEntry(merchantId: string, primarySku: string, companionSku: string): Promise<GrowthLedgerRow | undefined> {
  const rows = await db
    .select()
    .from(growthLedger)
    .where(
      and(
        eq(growthLedger.merchantId, merchantId),
        eq(growthLedger.primarySku, primarySku),
        eq(growthLedger.companionSku, companionSku)
      )
    )
    .limit(1);
  return rows[0] as GrowthLedgerRow | undefined;
}

export async function listLedgerForMerchant(merchantId: string): Promise<GrowthLedgerRow[]> {
  return (await db.select().from(growthLedger).where(eq(growthLedger.merchantId, merchantId))) as GrowthLedgerRow[];
}

export async function clearForMerchant(merchantId: string): Promise<void> {
  await db.delete(growthLedger).where(eq(growthLedger.merchantId, merchantId));
}
