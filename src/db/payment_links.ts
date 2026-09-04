/**
 * src/db/payment_links.ts — repository layer for `payment_links`.
 */

import { and, desc, eq, or } from "drizzle-orm";
import { db } from "./client";
import { paymentLinkRecords } from "./schema";

export interface PaymentLinkRow {
  id: string;
  merchantId: string;
  checkoutSessionId: string | null;
  razorpayPaymentLinkId: string | null;
  shortUrl: string | null;
  amountInr: number;
  description: string;
  status: string;
  createdAt: Date;
}

export async function insertPaymentLink(row: Omit<PaymentLinkRow, "createdAt">): Promise<PaymentLinkRow> {
  const [inserted] = await db.insert(paymentLinkRecords).values(row).returning();
  return inserted as PaymentLinkRow;
}

export async function listPaymentLinks(merchantId: string): Promise<PaymentLinkRow[]> {
  return (await db
    .select()
    .from(paymentLinkRecords)
    .where(eq(paymentLinkRecords.merchantId, merchantId))
    .orderBy(desc(paymentLinkRecords.createdAt))) as PaymentLinkRow[];
}

export async function updateStatusByIdOrRzpId(merchantId: string, idOrRzpId: string, status: string): Promise<PaymentLinkRow | undefined> {
  const [row] = await db
    .update(paymentLinkRecords)
    .set({ status })
    .where(
      and(
        eq(paymentLinkRecords.merchantId, merchantId),
        or(eq(paymentLinkRecords.id, idOrRzpId), eq(paymentLinkRecords.razorpayPaymentLinkId, idOrRzpId))
      )
    )
    .returning();
  return row as PaymentLinkRow | undefined;
}
