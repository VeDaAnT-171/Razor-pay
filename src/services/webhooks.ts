/**
 * src/services/webhooks.ts
 *
 * The real Razorpay webhook receiver. Razorpay signs every webhook body
 * with HMAC-SHA256 over the raw request body using the secret configured
 * in the Razorpay Dashboard (Settings -> Webhooks) — X-Razorpay-Signature.
 * This verifies that signature for real; an invalid or missing signature
 * is rejected before any state changes.
 *
 * One shared Razorpay account, cross-tenant lookup: this build has every
 * merchant settling through ONE platform Razorpay Test Mode account (see
 * README "One shared Razorpay account" for the real-production path —
 * Razorpay Route / linked accounts per merchant). A webhook therefore
 * carries no merchant identity of its own; the session (and so the
 * merchant) is found by the order/payment id it references, via the one
 * deliberately cross-tenant query in db/sessions.ts. Every state change
 * from that point on is scoped to that session's merchantId like
 * everything else in the codebase.
 *
 * To actually receive live webhooks, this endpoint needs a public URL
 * (e.g. via ngrok in dev) registered in the Razorpay Dashboard pointing
 * at POST /agent/v1/webhooks/razorpay, with RAZORPAY_WEBHOOK_SECRET set
 * to the same secret shown there. Without that, A-COS still exposes and
 * documents the endpoint, but nothing in this sandbox can deliver a real
 * webhook to it — that's an infrastructure limit, not something fakeable.
 *
 * Idempotency: Razorpay may redeliver the same event (at-least-once
 * delivery, possibly out of order). Every event carries an `event id` in
 * its payload id fields; we key on razorpay's `x-razorpay-event-id`
 * header when present, else a hash of the body, and never process the
 * same id twice.
 */

import { createHmac, timingSafeEqual, createHash } from "crypto";
import { writeAudit } from "./audit_log";
import { transitionSession } from "./checkout_session";
import * as sessionsRepo from "../db/sessions";
import * as repo from "../db/webhooks";

export interface WebhookEventRecord {
  id: string;
  event: string;
  received_at: string;
  signature_valid: boolean;
  processed: boolean;
  duplicate: boolean;
  handler: string;
  attempts: number;
  payload_summary: Record<string, unknown>;
  audit_id?: string;
}

function toDomain(row: repo.WebhookEventRow): WebhookEventRecord {
  return {
    id: row.id,
    event: row.event,
    received_at: row.receivedAt.toISOString(),
    signature_valid: row.signatureValid,
    processed: row.processed,
    duplicate: row.duplicate,
    handler: row.handler,
    attempts: row.attempts,
    payload_summary: row.payloadSummary as Record<string, unknown>,
    audit_id: row.auditId ?? undefined,
  };
}

export async function listWebhookEvents(merchantId: string): Promise<WebhookEventRecord[]> {
  const rows = await repo.listEventsForMerchant(merchantId);
  return rows.map(toDomain);
}

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signatureHeader, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function eventIdFor(headerEventId: string | undefined, rawBody: string): string {
  return headerEventId ?? createHash("sha256").update(rawBody).digest("hex");
}

export async function processWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  headerEventId: string | undefined
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const id = eventIdFor(headerEventId, rawBody);
  const signatureValid = verifyWebhookSignature(rawBody, signatureHeader);

  if (!signatureValid) {
    await repo.insertEvent({
      id, merchantId: null, event: "unknown", signatureValid: false,
      processed: false, duplicate: false, handler: "-", attempts: 1, payloadSummary: {}, auditId: null,
    });
    return { httpStatus: 400, body: { error: "INVALID_SIGNATURE" } };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, body: { error: "INVALID_JSON" } };
  }

  const eventName: string = parsed.event ?? "unknown";
  const existing = await repo.findEventById(id);
  const duplicate = !!existing;

  if (duplicate) {
    await repo.insertEvent({
      id: `${id}_dup_${Date.now()}`, merchantId: existing!.merchantId, event: eventName, signatureValid: true,
      processed: true, duplicate: true, handler: "payment-state-sync", attempts: (existing!.attempts ?? 1) + 1,
      payloadSummary: { event: eventName }, auditId: null,
    });
    if (existing!.merchantId) {
      await writeAudit(existing!.merchantId, {
        intent_id: id, step: "WEBHOOK_RECEIVED", outcome: "INFO", actor: "webhooks",
        reason: `Received ${eventName} (duplicate delivery)`, detail: { webhook_event_id: id, event: eventName },
      });
    }
    return { httpStatus: 200, body: { status: "OK", duplicate: true } };
  }

  const entity = parsed.payload?.payment?.entity ?? parsed.payload?.refund?.entity ?? parsed.payload?.order?.entity;
  const orderId: string | undefined = entity?.order_id ?? parsed.payload?.order?.entity?.id;
  const paymentId: string | undefined = parsed.payload?.payment?.entity?.id;
  const sessionRow = await sessionsRepo.findSessionByOrderOrPaymentGlobal(orderId, paymentId);
  const merchantId = sessionRow?.merchantId;

  if (merchantId) {
    await writeAudit(merchantId, {
      intent_id: sessionRow!.intentId, step: "WEBHOOK_RECEIVED", outcome: "INFO", actor: "webhooks",
      reason: `Received ${eventName}`, detail: { webhook_event_id: id, event: eventName },
    });
  }

  let handlerResult = "no matching session";
  let auditId: string | undefined;
  if (sessionRow && merchantId) {
    try {
      switch (eventName) {
        case "payment.authorized":
          await transitionSession(merchantId, sessionRow.id, "PAYMENT_AUTHORIZED", "webhooks",
            "payment.authorized webhook verified", { payment_status: "AUTHORIZED", razorpay_payment_id: paymentId });
          handlerResult = "payment authorized";
          break;
        case "payment.captured": {
          await transitionSession(merchantId, sessionRow.id, "PAYMENT_CAPTURED", "webhooks",
            "payment.captured webhook verified", { payment_status: "CAPTURED", razorpay_payment_id: paymentId });
          await transitionSession(merchantId, sessionRow.id, "ORDER_PAID", "webhooks",
            "Order marked paid following captured payment", { order_status: "PAID" });
          handlerResult = "payment captured — order marked paid";
          const a = await writeAudit(merchantId, {
            intent_id: sessionRow.intentId, step: "PAYMENT_CAPTURED", outcome: "PASS", actor: "webhooks",
            reason: `Payment ${paymentId} captured for ₹${sessionRow.finalAmountInr} — verified via signed webhook`,
            detail: { razorpay_payment_id: paymentId },
          });
          auditId = a.audit_id;
          break;
        }
        case "payment.failed":
          await transitionSession(merchantId, sessionRow.id, "PAYMENT_FAILED", "webhooks",
            "payment.failed webhook verified", { payment_status: "FAILED" });
          handlerResult = "payment failed";
          break;
        case "refund.processed":
          handlerResult = "refund acknowledged";
          break;
        default:
          handlerResult = `no handler for ${eventName}`;
      }
    } catch (err: any) {
      handlerResult = `handler error: ${err?.message ?? String(err)}`;
    }
  }

  if (merchantId) {
    const audit = await writeAudit(merchantId, {
      intent_id: sessionRow?.intentId ?? id,
      step: "WEBHOOK_VERIFIED",
      outcome: "PASS",
      actor: "webhooks",
      reason: `${eventName} processed — ${handlerResult}`,
      detail: { webhook_event_id: id, event: eventName, order_id: orderId, payment_id: paymentId },
    });
    auditId = auditId ?? audit.audit_id;
  }

  await repo.insertEvent({
    id, merchantId: merchantId ?? null, event: eventName, signatureValid: true,
    processed: !!merchantId, duplicate: false, handler: "payment-state-sync", attempts: 1,
    payloadSummary: { event: eventName, order_id: orderId, payment_id: paymentId, result: handlerResult },
    auditId: auditId ?? null,
  });

  return { httpStatus: 200, body: { status: "OK" } };
}

/** Dev helper: fire a synthetic, correctly-signed test event through the same real verification path. */
export function buildSignedTestEvent(event: string, payload: Record<string, unknown>): { body: string; signature: string } {
  const body = JSON.stringify({ event, payload });
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "change-me-in-production";
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return { body, signature };
}
