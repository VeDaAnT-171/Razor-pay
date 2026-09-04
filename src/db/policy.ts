/**
 * src/db/policy.ts — repository layer for `policies`, `agent_profiles`,
 * `velocity_events`. Every query scoped by merchantId.
 */

import { randomUUID } from "crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "./client";
import { policies, agentProfiles, velocityEvents } from "./schema";

export interface PolicyRow {
  id: string;
  merchantId: string;
  version: number;
  status: string;
  autoApproveLimitInr: number;
  velocity: unknown;
  allowedCategories: unknown;
  blockedCategories: unknown;
  maxQuantityPerItem: number;
  maxAutoDiscountPct: number;
  maxAbsoluteDiscountInr: number | null;
  allowedPaymentMethods: unknown;
  blockedPaymentMethods: unknown;
  newCustomerLimitInr: number | null;
  humanApprovalNewCategory: boolean;
  humanApprovalAddressChange: boolean;
  humanApprovalPaymentMethodChange: boolean;
  createdAt: Date;
  publishedAt: Date | null;
}

export const DRAFT_VERSION_SENTINEL = -1;

export type PolicyInsert = Omit<PolicyRow, "id" | "merchantId" | "createdAt"> & { createdAt?: Date };

export async function insertPolicy(merchantId: string, values: PolicyInsert): Promise<PolicyRow> {
  const [row] = await db
    .insert(policies)
    .values({ id: randomUUID(), merchantId, ...values, createdAt: values.createdAt ?? new Date() })
    .returning();
  return row as PolicyRow;
}

export async function findPublishedPolicy(merchantId: string): Promise<PolicyRow | undefined> {
  const rows = await db
    .select()
    .from(policies)
    .where(and(eq(policies.merchantId, merchantId), eq(policies.status, "published")))
    .orderBy(desc(policies.version))
    .limit(1);
  return rows[0] as PolicyRow | undefined;
}

export async function findDraftPolicy(merchantId: string): Promise<PolicyRow | undefined> {
  const rows = await db
    .select()
    .from(policies)
    .where(and(eq(policies.merchantId, merchantId), eq(policies.version, DRAFT_VERSION_SENTINEL)))
    .limit(1);
  return rows[0] as PolicyRow | undefined;
}

export async function deleteDraftPolicy(merchantId: string): Promise<void> {
  await db
    .delete(policies)
    .where(and(eq(policies.merchantId, merchantId), eq(policies.version, DRAFT_VERSION_SENTINEL)));
}

export async function listPublishedHistory(merchantId: string): Promise<PolicyRow[]> {
  return (await db
    .select()
    .from(policies)
    .where(and(eq(policies.merchantId, merchantId), eq(policies.status, "published")))
    .orderBy(policies.version)) as PolicyRow[];
}

/* ------------------------------------------------------------------ */
/* Agent profiles                                                       */
/* ------------------------------------------------------------------ */

export interface AgentProfileRow {
  id: string;
  merchantId: string;
  agentId: string;
  verified: boolean;
  protocol: string;
  perTransactionInr: number;
  hourlyInr: number;
  dailyInr: number;
  monthlyInr: number;
  discountAuthorityPct: number;
  maxQuantity: number;
  allowedCategories: unknown;
  restrictedCategories: unknown;
}

export async function findAgentProfile(merchantId: string, agentId: string): Promise<AgentProfileRow | undefined> {
  const rows = await db
    .select()
    .from(agentProfiles)
    .where(and(eq(agentProfiles.merchantId, merchantId), eq(agentProfiles.agentId, agentId)))
    .limit(1);
  return rows[0] as AgentProfileRow | undefined;
}

export async function insertAgentProfile(
  merchantId: string,
  values: Omit<AgentProfileRow, "id" | "merchantId">
): Promise<AgentProfileRow> {
  const [row] = await db
    .insert(agentProfiles)
    .values({ id: randomUUID(), merchantId, ...values })
    .onConflictDoNothing({ target: [agentProfiles.merchantId, agentProfiles.agentId] })
    .returning();
  if (row) return row as AgentProfileRow;
  // Lost the insert race — someone else created it first; fetch what's there.
  return (await findAgentProfile(merchantId, values.agentId)) as AgentProfileRow;
}

/* ------------------------------------------------------------------ */
/* Velocity events                                                      */
/* ------------------------------------------------------------------ */

export async function insertVelocityEvent(
  merchantId: string,
  agentId: string,
  amountInr: number,
  failed: boolean
): Promise<void> {
  await db.insert(velocityEvents).values({ id: randomUUID(), merchantId, agentId, amountInr, failed });
}

export interface WindowSum {
  sumInr: number;
  count: number;
}

/** Sums successful-spend amount and counts all attempts (or, if onlyFailed, counts only failed attempts) within a rolling window. */
export async function windowSum(
  merchantId: string,
  agentId: string,
  windowMs: number,
  onlyFailed = false
): Promise<WindowSum> {
  const cutoff = new Date(Date.now() - windowMs);
  const rows = await db
    .select({
      sumInr: sql<string>`COALESCE(SUM(CASE WHEN NOT ${velocityEvents.failed} THEN ${velocityEvents.amountInr} ELSE 0 END), 0)`,
      count: onlyFailed
        ? sql<string>`COUNT(*) FILTER (WHERE ${velocityEvents.failed})`
        : sql<string>`COUNT(*)`,
    })
    .from(velocityEvents)
    .where(
      and(
        eq(velocityEvents.merchantId, merchantId),
        eq(velocityEvents.agentId, agentId),
        gte(velocityEvents.ts, cutoff)
      )
    );
  const r = rows[0];
  return { sumInr: Number(r?.sumInr ?? 0), count: Number(r?.count ?? 0) };
}

export async function clearVelocityEventsForMerchant(merchantId: string): Promise<void> {
  await db.delete(velocityEvents).where(eq(velocityEvents.merchantId, merchantId));
}
