/**
 * src/db/approvals.ts — repository layer for `approvals`.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "./client";
import { approvals } from "./schema";

export interface ApprovalRow {
  id: string;
  merchantId: string;
  checkoutSessionId: string;
  kind: string;
  title: string;
  reason: string;
  amountInr: number;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

export async function insertApproval(row: Omit<ApprovalRow, "createdAt" | "resolvedAt">): Promise<ApprovalRow> {
  const [inserted] = await db.insert(approvals).values(row).returning();
  return inserted as ApprovalRow;
}

export async function findApproval(merchantId: string, id: string): Promise<ApprovalRow | undefined> {
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.merchantId, merchantId), eq(approvals.id, id)))
    .limit(1);
  return rows[0] as ApprovalRow | undefined;
}

export async function listApprovals(merchantId: string): Promise<ApprovalRow[]> {
  return (await db
    .select()
    .from(approvals)
    .where(eq(approvals.merchantId, merchantId))
    .orderBy(desc(approvals.createdAt))) as ApprovalRow[];
}

export async function updateApproval(
  merchantId: string,
  id: string,
  patch: Partial<Pick<ApprovalRow, "status" | "resolvedAt">>
): Promise<ApprovalRow | undefined> {
  const [row] = await db
    .update(approvals)
    .set(patch)
    .where(and(eq(approvals.merchantId, merchantId), eq(approvals.id, id)))
    .returning();
  return row as ApprovalRow | undefined;
}
