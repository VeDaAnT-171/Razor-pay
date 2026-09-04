/**
 * src/db/webhooks.ts — repository layer for `webhook_events`.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "./client";
import { webhookEvents } from "./schema";

export interface WebhookEventRow {
  id: string;
  merchantId: string | null;
  event: string;
  receivedAt: Date;
  signatureValid: boolean;
  processed: boolean;
  duplicate: boolean;
  handler: string;
  attempts: number;
  payloadSummary: unknown;
  auditId: string | null;
}

export async function findEventById(id: string): Promise<WebhookEventRow | undefined> {
  const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id)).limit(1);
  return rows[0] as WebhookEventRow | undefined;
}

export async function insertEvent(row: Omit<WebhookEventRow, "receivedAt">): Promise<WebhookEventRow> {
  const [inserted] = await db.insert(webhookEvents).values(row).returning();
  return inserted as WebhookEventRow;
}

export async function listEventsForMerchant(merchantId: string): Promise<WebhookEventRow[]> {
  return (await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.merchantId, merchantId))
    .orderBy(desc(webhookEvents.receivedAt))) as WebhookEventRow[];
}
