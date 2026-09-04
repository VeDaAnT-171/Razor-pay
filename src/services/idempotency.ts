/**
 * src/services/idempotency.ts
 *
 * Real, merchant-scoped, Postgres-backed idempotency-key handling for
 * every money-moving endpoint (checkout, refund, payment-link creation).
 * A client-supplied `Idempotency-Key` header (or body field) is hashed
 * against the endpoint name; a repeated key within the retention window
 * returns the ORIGINAL recorded result instead of re-executing the
 * operation — so a network retry can never double-charge or double-refund.
 */

import * as repo from "../db/idempotency";

const RETENTION_MS = 24 * 60 * 60 * 1000;

export async function getIdempotentResult<T = unknown>(merchantId: string, scope: string, key: string | undefined): Promise<T | undefined> {
  if (!key) return undefined;
  const rec = await repo.findRecord(merchantId, scope, key);
  if (!rec) return undefined;
  if (Date.now() - rec.createdAt.getTime() > RETENTION_MS) return undefined;
  return rec.result as T;
}

export async function saveIdempotentResult(merchantId: string, scope: string, key: string | undefined, result: unknown): Promise<void> {
  if (!key) return;
  await repo.saveRecord(merchantId, scope, key, result);
}

export async function purgeExpiredIdempotencyRecords(): Promise<void> {
  await repo.purgeExpired(RETENTION_MS);
}
