/**
 * src/db/audit.ts — repository layer for `audit_log_entries`.
 *
 * The hash chain is kept PER MERCHANT: each tenant has its own
 * independently-ordered, independently-verifiable chain, ordered by the
 * monotonic `seq` column (not by timestamp, which can collide under
 * concurrent writes). Correctness of `seq` assignment relies on the
 * caller (services/audit_log.ts) serializing writes per merchant with an
 * in-process mutex — see the note there on what that does and doesn't
 * cover.
 */

import { and, asc, eq, desc } from "drizzle-orm";
import { db } from "./client";
import { auditLogEntries } from "./schema";

export interface AuditRow {
  id: string;
  merchantId: string;
  intentId: string;
  step: string;
  outcome: string;
  timestamp: Date;
  actor: string;
  reason: string;
  detail: unknown;
  prevHash: string;
  hash: string;
  seq: number;
}

export type AuditInsert = Omit<AuditRow, never>;

export async function appendAuditEntry(values: AuditInsert): Promise<AuditRow> {
  const [row] = await db.insert(auditLogEntries).values(values).returning();
  return row as AuditRow;
}

export async function findLastEntry(merchantId: string): Promise<AuditRow | undefined> {
  const rows = await db
    .select()
    .from(auditLogEntries)
    .where(eq(auditLogEntries.merchantId, merchantId))
    .orderBy(desc(auditLogEntries.seq))
    .limit(1);
  return rows[0] as AuditRow | undefined;
}

export async function listByIntent(merchantId: string, intentId: string): Promise<AuditRow[]> {
  return (await db
    .select()
    .from(auditLogEntries)
    .where(and(eq(auditLogEntries.merchantId, merchantId), eq(auditLogEntries.intentId, intentId)))
    .orderBy(asc(auditLogEntries.seq))) as AuditRow[];
}

export async function listAll(merchantId: string): Promise<AuditRow[]> {
  return (await db
    .select()
    .from(auditLogEntries)
    .where(eq(auditLogEntries.merchantId, merchantId))
    .orderBy(asc(auditLogEntries.seq))) as AuditRow[];
}

export async function clearForMerchant(merchantId: string): Promise<void> {
  await db.delete(auditLogEntries).where(eq(auditLogEntries.merchantId, merchantId));
}
