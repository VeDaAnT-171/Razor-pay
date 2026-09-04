/**
 * src/db/refunds.ts — repository layer for `refunds`.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "./client";
import { refundRecords } from "./schema";

export interface RefundRow {
  id: string;
  merchantId: string;
  checkoutSessionId: string;
  razorpayRefundId: string | null;
  amountInr: number;
  reason: string;
  status: string;
  simulated: boolean;
  createdAt: Date;
}

export async function insertRefund(row: Omit<RefundRow, "createdAt">): Promise<RefundRow> {
  const [inserted] = await db.insert(refundRecords).values(row).returning();
  return inserted as RefundRow;
}

export async function listRefunds(merchantId: string): Promise<RefundRow[]> {
  return (await db
    .select()
    .from(refundRecords)
    .where(eq(refundRecords.merchantId, merchantId))
    .orderBy(desc(refundRecords.createdAt))) as RefundRow[];
}
