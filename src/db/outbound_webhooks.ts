/**
 * src/db/outbound_webhooks.ts — repository layer for outbound webhook
 * endpoints (the merchant's own server, registered to receive A-COS
 * event notifications) and their delivery log.
 */

import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./client";
import { outboundWebhookEndpoints, outboundWebhookDeliveries } from "./schema";

export interface OutboundEndpointRow {
  id: string;
  merchantId: string;
  url: string;
  secret: string;
  secretPrefix: string;
  events: unknown;
  enabled: boolean;
  createdAt: Date;
}

export interface OutboundDeliveryRow {
  id: string;
  merchantId: string;
  endpointId: string;
  event: string;
  url: string;
  success: boolean;
  statusCode: number | null;
  error: string | null;
  payloadSummary: unknown;
  createdAt: Date;
}

export async function insertEndpoint(input: {
  merchantId: string;
  url: string;
  secret: string;
  secretPrefix: string;
  events: string[];
}): Promise<OutboundEndpointRow> {
  const id = `whep_${randomUUID()}`;
  const [row] = await db
    .insert(outboundWebhookEndpoints)
    .values({
      id,
      merchantId: input.merchantId,
      url: input.url,
      secret: input.secret,
      secretPrefix: input.secretPrefix,
      events: input.events,
    })
    .returning();
  return row as OutboundEndpointRow;
}

export async function listEndpointsForMerchant(merchantId: string): Promise<OutboundEndpointRow[]> {
  return (await db
    .select()
    .from(outboundWebhookEndpoints)
    .where(eq(outboundWebhookEndpoints.merchantId, merchantId))
    .orderBy(desc(outboundWebhookEndpoints.createdAt))) as OutboundEndpointRow[];
}

/** Every enabled endpoint across every tenant that subscribes to `event` — used by the dispatcher, never exposed directly. */
export async function listEnabledEndpointsForEvent(merchantId: string, event: string): Promise<OutboundEndpointRow[]> {
  const rows = (await db
    .select()
    .from(outboundWebhookEndpoints)
    .where(and(eq(outboundWebhookEndpoints.merchantId, merchantId), eq(outboundWebhookEndpoints.enabled, true)))) as OutboundEndpointRow[];
  return rows.filter((r) => Array.isArray(r.events) && (r.events as string[]).includes(event));
}

export async function deleteEndpoint(merchantId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(outboundWebhookEndpoints)
    .where(and(eq(outboundWebhookEndpoints.id, id), eq(outboundWebhookEndpoints.merchantId, merchantId)))
    .returning({ id: outboundWebhookEndpoints.id });
  return deleted.length > 0;
}

export async function insertDelivery(input: {
  merchantId: string;
  endpointId: string;
  event: string;
  url: string;
  success: boolean;
  statusCode: number | null;
  error: string | null;
  payloadSummary: unknown;
}): Promise<OutboundDeliveryRow> {
  const id = `whd_${randomUUID()}`;
  const [row] = await db
    .insert(outboundWebhookDeliveries)
    .values({ id, ...input })
    .returning();
  return row as OutboundDeliveryRow;
}

export async function listRecentDeliveries(merchantId: string, limit = 20): Promise<OutboundDeliveryRow[]> {
  return (await db
    .select()
    .from(outboundWebhookDeliveries)
    .where(eq(outboundWebhookDeliveries.merchantId, merchantId))
    .orderBy(desc(outboundWebhookDeliveries.createdAt))
    .limit(limit)) as OutboundDeliveryRow[];
}
