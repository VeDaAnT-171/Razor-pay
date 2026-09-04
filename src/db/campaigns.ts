/**
 * src/db/campaigns.ts — repository layer for `campaigns`.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./client";
import { campaigns } from "./schema";

export interface CampaignRow {
  id: string;
  merchantId: string;
  name: string;
  triggerIntent: string;
  productSkus: unknown; // string[]
  discountInr: number;
  maxDiscountPct: number;
  budgetInr: number;
  spentInr: number;
  dailyOrderLimit: number;
  redemptions: number;
  status: string;
  createdAt: Date;
  activatedAt: Date | null;
}

export async function insertCampaign(row: Omit<CampaignRow, "createdAt">): Promise<CampaignRow> {
  const [inserted] = await db.insert(campaigns).values(row).returning();
  return inserted as CampaignRow;
}

export async function findCampaign(merchantId: string, id: string): Promise<CampaignRow | undefined> {
  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.merchantId, merchantId), eq(campaigns.id, id)))
    .limit(1);
  return rows[0] as CampaignRow | undefined;
}

export async function listCampaigns(merchantId: string): Promise<CampaignRow[]> {
  return (await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.merchantId, merchantId))
    .orderBy(desc(campaigns.createdAt))) as CampaignRow[];
}

export async function listActiveCampaignsWithBudget(merchantId: string): Promise<CampaignRow[]> {
  return (await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.merchantId, merchantId), eq(campaigns.status, "active")))) as CampaignRow[];
}

export async function updateCampaign(
  merchantId: string,
  id: string,
  patch: Partial<Omit<CampaignRow, "id" | "merchantId" | "createdAt">>
): Promise<CampaignRow | undefined> {
  const [row] = await db
    .update(campaigns)
    .set(patch)
    .where(and(eq(campaigns.merchantId, merchantId), eq(campaigns.id, id)))
    .returning();
  return row as CampaignRow | undefined;
}

/**
 * Atomically records a redemption — adds to spent_inr, increments
 * redemptions, and flips to budget_exhausted if the budget is now used up
 * — as a single UPDATE whose SET expressions reference the row's current
 * values, so two concurrent checkouts applying the same campaign can't
 * race and under-count spend (no read-modify-write round trip).
 */
export async function recordRedemption(merchantId: string, id: string, discountAppliedInr: number): Promise<CampaignRow | undefined> {
  const [row] = await db
    .update(campaigns)
    .set({
      spentInr: sql`${campaigns.spentInr} + ${discountAppliedInr}`,
      redemptions: sql`${campaigns.redemptions} + 1`,
      status: sql`CASE WHEN ${campaigns.spentInr} + ${discountAppliedInr} >= ${campaigns.budgetInr} THEN 'budget_exhausted' ELSE ${campaigns.status} END`,
    })
    .where(and(eq(campaigns.merchantId, merchantId), eq(campaigns.id, id)))
    .returning();
  return row as CampaignRow | undefined;
}
