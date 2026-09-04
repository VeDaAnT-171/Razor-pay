/**
 * src/services/refunds.ts
 *
 * Real, merchant-scoped refunds against a captured Razorpay payment.
 * Refuses to refund a session that hasn't actually captured real
 * (non-simulated) money — that's the whole point of tracking
 * payment_status/simulated_payment separately on the CheckoutSession.
 */

import { randomUUID } from "crypto";
import { getSession, transitionSession } from "./checkout_session";
import { createRazorpayRefund } from "./razorpay_client";
import { writeAudit } from "./audit_log";
import { getIdempotentResult, saveIdempotentResult } from "./idempotency";
import * as repo from "../db/refunds";

export interface RefundRecord {
  refund_id: string;
  checkout_session_id: string;
  razorpay_refund_id?: string;
  amount_inr: number;
  reason: string;
  status: "PROCESSED" | "FAILED";
  simulated: boolean;
  created_at: string;
}

function toDomain(row: repo.RefundRow): RefundRecord {
  return {
    refund_id: row.id,
    checkout_session_id: row.checkoutSessionId,
    razorpay_refund_id: row.razorpayRefundId ?? undefined,
    amount_inr: row.amountInr,
    reason: row.reason,
    status: row.status as RefundRecord["status"],
    simulated: row.simulated,
    created_at: row.createdAt.toISOString(),
  };
}

export async function listRefunds(merchantId: string): Promise<RefundRecord[]> {
  const rows = await repo.listRefunds(merchantId);
  return rows.map(toDomain);
}

export async function processRefund(
  merchantId: string,
  sessionId: string,
  amountInr: number | undefined,
  reason: string,
  idempotencyKey?: string
): Promise<{ ok: true; refund: RefundRecord } | { ok: false; error: string; httpStatus: number }> {
  const cached = await getIdempotentResult<{ ok: true; refund: RefundRecord }>(merchantId, "refund", idempotencyKey);
  if (cached) {
    await writeAudit(merchantId, {
      intent_id: sessionId,
      step: "IDEMPOTENT_REPLAY",
      outcome: "INFO",
      actor: "refunds",
      reason: `Retry detected for idempotency key — returning original refund result, no duplicate refund issued`,
      detail: { idempotency_key: idempotencyKey },
    });
    return cached;
  }

  const session = await getSession(merchantId, sessionId);
  if (!session) return { ok: false, error: "Unknown checkout_session_id", httpStatus: 404 };

  const amount = amountInr ?? session.final_amount_inr;

  if (session.payment_status !== "CAPTURED") {
    return { ok: false, error: `Cannot refund — payment_status is ${session.payment_status}, not CAPTURED`, httpStatus: 409 };
  }
  if (session.simulated_payment) {
    return {
      ok: false,
      error: "This session's payment was SIMULATED (Test Lab), not a real Razorpay capture — nothing to refund on Razorpay's side.",
      httpStatus: 409,
    };
  }
  if (!session.razorpay_payment_id) {
    return { ok: false, error: "Session has no razorpay_payment_id on record", httpStatus: 409 };
  }
  if (amount > session.final_amount_inr) {
    return { ok: false, error: `Refund amount ₹${amount} exceeds original payment ₹${session.final_amount_inr}`, httpStatus: 400 };
  }

  await writeAudit(merchantId, {
    intent_id: sessionId,
    step: "REFUND_REQUESTED",
    outcome: "INFO",
    actor: "refunds",
    reason: `Refund of ₹${amount} requested — ${reason}`,
    detail: { amount_inr: amount, reason },
  });

  try {
    const rzpRefund = await createRazorpayRefund({
      paymentId: session.razorpay_payment_id,
      amountInr: amount,
      notes: { reason, checkout_session_id: sessionId, merchant_id: merchantId },
    });

    const row = await repo.insertRefund({
      id: `rfnd_${randomUUID()}`,
      merchantId,
      checkoutSessionId: sessionId,
      razorpayRefundId: (rzpRefund as any).id,
      amountInr: amount,
      reason,
      status: "PROCESSED",
      simulated: false,
    });

    const full = amount >= session.final_amount_inr;
    await transitionSession(merchantId, sessionId, full ? "REFUNDED" : "PARTIALLY_REFUNDED", "refunds",
      `Razorpay refund ${row.razorpayRefundId} processed for ₹${amount}`,
      { payment_status: full ? "REFUNDED" : "PARTIALLY_REFUNDED" });

    await writeAudit(merchantId, {
      intent_id: sessionId,
      step: "REFUND_PROCESSED",
      outcome: "PASS",
      actor: "refunds",
      reason: `Razorpay refund ${row.razorpayRefundId} processed for ₹${amount}`,
      detail: { razorpay_refund_id: row.razorpayRefundId, amount_inr: amount, full },
    });

    const result = { ok: true as const, refund: toDomain(row) };
    await saveIdempotentResult(merchantId, "refund", idempotencyKey, result);
    return result;
  } catch (err: any) {
    await writeAudit(merchantId, {
      intent_id: sessionId,
      step: "REFUND_PROCESSED",
      outcome: "FAIL",
      actor: "refunds",
      reason: `Razorpay refund failed: ${err?.message ?? String(err)}`,
      detail: { error: err?.message ?? String(err) },
    });
    return { ok: false, error: `Razorpay refund failed: ${err?.message ?? String(err)}`, httpStatus: 502 };
  }
}
