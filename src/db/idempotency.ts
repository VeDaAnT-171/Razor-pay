/**
 * src/db/idempotency.ts — repository layer for `idempotency_records`.
 */

import { randomUUID } from "crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "./client";
import { idempotencyRecords } from "./schema";

export interface IdempotencyRow {
  id: string;
  merchantId: string;
  scope: string;
  key: string;
  result: unknown;
  createdAt: Date;
}

export async function findRecord(merchantId: string, scope: string, key: string): Promise<IdempotencyRow | undefined> {
  const rows = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.merchantId, merchantId),
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.key, key)
      )
    )
    .limit(1);
  return rows[0] as IdempotencyRow | undefined;
}

export async function saveRecord(merchantId: string, scope: string, key: string, result: unknown): Promise<void> {
  await db
    .insert(idempotencyRecords)
    .values({ id: randomUUID(), merchantId, scope, key, result: result as object })
    .onConflictDoUpdate({
      target: [idempotencyRecords.merchantId, idempotencyRecords.scope, idempotencyRecords.key],
      set: { result: result as object, createdAt: new Date() },
    });
}

export async function purgeExpired(olderThanMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanMs);
  await db.delete(idempotencyRecords).where(lt(idempotencyRecords.createdAt, cutoff));
}
