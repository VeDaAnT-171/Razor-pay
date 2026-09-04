/**
 * src/db/sessions.ts — repository layer for `checkout_sessions`.
 */

import { and, desc, eq, or } from "drizzle-orm";
import { db } from "./client";
import { checkoutSessions } from "./schema";

export interface SessionRow {
  id: string;
  merchantId: string;
  customerId: string | null;
  buyerAgentId: string;
  protocol: string;
  intentId: string;
  cart: unknown;
  quoteId: string | null;
  authorizationInr: number;
  policyVersion: number;
  policyDecision: string | null;
  riskDecision: string;
  shippingInr: number;
  taxInr: number;
  discountInr: number;
  finalAmountInr: number;
  currency: string;
  paymentMethod: string | null;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  paymentStatus: string;
  orderStatus: string;
  state: string;
  simulatedPayment: boolean;
  expiresAt: Date | null;
  idempotencyKey: string | null;
  auditId: string | null;
  campaignId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function insertSession(row: Omit<SessionRow, "createdAt" | "updatedAt">): Promise<SessionRow> {
  const [inserted] = await db.insert(checkoutSessions).values(row).returning();
  return inserted as SessionRow;
}

export async function findSessionById(merchantId: string, id: string): Promise<SessionRow | undefined> {
  const rows = await db
    .select()
    .from(checkoutSessions)
    .where(and(eq(checkoutSessions.merchantId, merchantId), eq(checkoutSessions.id, id)))
    .limit(1);
  return rows[0] as SessionRow | undefined;
}

export async function findSessionByIntent(merchantId: string, intentId: string): Promise<SessionRow | undefined> {
  const rows = await db
    .select()
    .from(checkoutSessions)
    .where(and(eq(checkoutSessions.merchantId, merchantId), eq(checkoutSessions.intentId, intentId)))
    .limit(1);
  return rows[0] as SessionRow | undefined;
}

export async function findSessionByOrderOrPayment(
  merchantId: string,
  orderId?: string,
  paymentId?: string
): Promise<SessionRow | undefined> {
  const all = await listSessions(merchantId);
  return all.find((s) => (orderId && s.razorpayOrderId === orderId) || (paymentId && s.razorpayPaymentId === paymentId));
}

/**
 * Cross-tenant lookup used ONLY by the webhook handler: an inbound
 * Razorpay webhook carries no merchant identity of its own (see
 * services/webhooks.ts), so the session — and therefore the merchant — is
 * found by the Razorpay order/payment id, without a merchantId filter.
 * No other caller in this codebase is allowed to query sessions without
 * scoping by merchantId.
 */
export async function findSessionByOrderOrPaymentGlobal(orderId?: string, paymentId?: string): Promise<SessionRow | undefined> {
  if (!orderId && !paymentId) return undefined;
  const conditions = [];
  if (orderId) conditions.push(eq(checkoutSessions.razorpayOrderId, orderId));
  if (paymentId) conditions.push(eq(checkoutSessions.razorpayPaymentId, paymentId));
  const rows = await db
    .select()
    .from(checkoutSessions)
    .where(or(...conditions))
    .limit(1);
  return rows[0] as SessionRow | undefined;
}

export async function listSessions(merchantId: string): Promise<SessionRow[]> {
  return (await db
    .select()
    .from(checkoutSessions)
    .where(eq(checkoutSessions.merchantId, merchantId))
    .orderBy(desc(checkoutSessions.createdAt))) as SessionRow[];
}

export async function updateSession(
  merchantId: string,
  id: string,
  patch: Partial<Omit<SessionRow, "id" | "merchantId" | "createdAt">>
): Promise<SessionRow> {
  const [row] = await db
    .update(checkoutSessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(checkoutSessions.merchantId, merchantId), eq(checkoutSessions.id, id)))
    .returning();
  return row as SessionRow;
}

export async function clearForMerchant(merchantId: string): Promise<void> {
  await db.delete(checkoutSessions).where(eq(checkoutSessions.merchantId, merchantId));
}
