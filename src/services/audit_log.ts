/**
 * src/services/audit_log.ts
 *
 * Immutable, hash-chained audit logging — now per-merchant and
 * Postgres-backed. Every decision step in the checkout lifecycle (Intent,
 * Protocol Translation, Policy Check, Mandate Verification, Negotiation,
 * Settlement, Failure...) is written here; each entry embeds the SHA-256
 * hash of the previous entry IN THE SAME MERCHANT'S CHAIN, so any
 * retroactive edit breaks that tenant's chain and is detectable by
 * `verifyChain(merchantId)`. One tenant's chain is fully independent of
 * every other tenant's — no cross-tenant ordering is implied or checked.
 *
 * Writes for a given merchant are serialized through an in-process mutex
 * (src/utils/mutex.ts) so two concurrent requests can't both read the same
 * "last hash" and fork the chain — see that file for what this does and
 * doesn't cover under horizontal scaling.
 */

import { randomUUID, createHash } from "crypto";
import { AuditLogEntry, AuditStep } from "../schema/types";
import * as repo from "../db/audit";
import { withKeyLock } from "../utils/mutex";

const GENESIS_HASH = "0".repeat(64);

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively so
 * the same logical value always produces the same byte string, regardless
 * of insertion order. This matters because Postgres `jsonb` does NOT
 * preserve object key order on round-trip (per the Postgres docs — it's
 * free to reorder keys internally), so a naive `JSON.stringify` of a value
 * re-fetched from the DB can differ byte-for-byte from the same value
 * stringified at write time even though nothing changed. Hashing must be
 * computed over this canonical form on both the write path and the verify
 * path, or the hash chain will spuriously "break" on every entry whose
 * `detail` contains a nested object. Array order IS preserved by jsonb and
 * by this function — only object keys are sorted.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

function toDomain(row: repo.AuditRow): AuditLogEntry {
  return {
    audit_id: row.id,
    intent_id: row.intentId,
    step: row.step as AuditStep,
    outcome: row.outcome as "PASS" | "FAIL" | "INFO",
    timestamp: row.timestamp.toISOString(),
    actor: row.actor,
    reason: row.reason,
    detail: row.detail as Record<string, unknown>,
    prev_hash: row.prevHash,
    hash: row.hash,
  };
}

export interface WriteAuditParams {
  intent_id: string;
  step: AuditStep;
  outcome: "PASS" | "FAIL" | "INFO";
  actor: string;
  reason: string;
  detail?: Record<string, unknown>;
}

/**
 * Appends one immutable audit entry for `merchantId` and returns it (with
 * its computed hash, so callers can surface `audit_id` to the client for
 * traceability). Serialized per-merchant so the chain can never fork.
 */
export async function writeAudit(merchantId: string, params: WriteAuditParams): Promise<AuditLogEntry> {
  return withKeyLock(`audit:${merchantId}`, async () => {
    const last = await repo.findLastEntry(merchantId);
    const prev_hash = last?.hash ?? GENESIS_HASH;
    const timestamp = new Date();
    const audit_id = randomUUID();

    const payloadForHash = stableStringify({
      audit_id,
      intent_id: params.intent_id,
      step: params.step,
      outcome: params.outcome,
      timestamp: timestamp.toISOString(),
      actor: params.actor,
      reason: params.reason,
      detail: params.detail ?? {},
      prev_hash,
    });
    const hash = sha256(payloadForHash);

    const row = await repo.appendAuditEntry({
      id: audit_id,
      merchantId,
      intentId: params.intent_id,
      step: params.step,
      outcome: params.outcome,
      timestamp,
      actor: params.actor,
      reason: params.reason,
      detail: params.detail ?? {},
      prevHash: prev_hash,
      hash,
      seq: (last?.seq ?? 0) + 1,
    });

    return toDomain(row);
  });
}

export async function getAuditTrail(merchantId: string, intentId: string): Promise<AuditLogEntry[]> {
  const rows = await repo.listByIntent(merchantId, intentId);
  return rows.map(toDomain);
}

export async function getFullAuditLog(merchantId: string): Promise<AuditLogEntry[]> {
  const rows = await repo.listAll(merchantId);
  return rows.map(toDomain);
}

/** Walks a merchant's hash chain and confirms no entry has been altered, reordered, or removed. */
export async function verifyChain(merchantId: string): Promise<{ valid: boolean; brokenAt?: string }> {
  const rows = await repo.listAll(merchantId);
  let expectedPrev = GENESIS_HASH;

  for (const row of rows) {
    if (row.prevHash !== expectedPrev) {
      return { valid: false, brokenAt: row.id };
    }
    const payloadForHash = stableStringify({
      audit_id: row.id,
      intent_id: row.intentId,
      step: row.step,
      outcome: row.outcome,
      timestamp: row.timestamp.toISOString(),
      actor: row.actor,
      reason: row.reason,
      detail: row.detail,
      prev_hash: row.prevHash,
    });
    if (sha256(payloadForHash) !== row.hash) {
      return { valid: false, brokenAt: row.id };
    }
    expectedPrev = row.hash;
  }
  return { valid: true };
}

/** Test/demo helper — never called from production routes. */
export async function resetAuditLogForTests(merchantId: string): Promise<void> {
  await repo.clearForMerchant(merchantId);
}
