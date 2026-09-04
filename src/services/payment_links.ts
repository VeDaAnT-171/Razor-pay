/**
 * src/services/payment_links.ts
 *
 * Real, merchant-scoped Razorpay Payment Links. The primary use in A-COS
 * is the recovery path from section 15 of the spec: when an autonomous
 * agentic checkout can't complete (mandate breach, quote expiry, payment
 * failure), instead of silently giving up, A-COS creates a real,
 * human-payable link the customer can complete manually.
 */

import { randomUUID } from "crypto";
import { createRazorpayPaymentLink } from "./razorpay_client";
import { writeAudit } from "./audit_log";
import * as repo from "../db/payment_links";

export interface PaymentLinkRecord {
  id: string;
  checkout_session_id?: string;
  razorpay_payment_link_id?: string;
  short_url?: string;
  amount_inr: number;
  description: string;
  status: "created" | "paid" | "cancelled" | "expired" | "failed";
  created_at: string;
}

function toDomain(row: repo.PaymentLinkRow): PaymentLinkRecord {
  return {
    id: row.id,
    checkout_session_id: row.checkoutSessionId ?? undefined,
    razorpay_payment_link_id: row.razorpayPaymentLinkId ?? undefined,
    short_url: row.shortUrl ?? undefined,
    amount_inr: row.amountInr,
    description: row.description,
    status: row.status as PaymentLinkRecord["status"],
    created_at: row.createdAt.toISOString(),
  };
}

export async function listPaymentLinks(merchantId: string): Promise<PaymentLinkRecord[]> {
  const rows = await repo.listPaymentLinks(merchantId);
  return rows.map(toDomain);
}

export async function createPaymentLink(
  merchantId: string,
  params: {
    checkout_session_id?: string;
    amount_inr: number;
    description: string;
    customer_name?: string;
    customer_email?: string;
    customer_contact?: string;
  }
): Promise<{ ok: true; link: PaymentLinkRecord } | { ok: false; error: string; httpStatus: number }> {
  const refId = `pl_${randomUUID()}`;

  try {
    const rzpLink = await createRazorpayPaymentLink({
      amountInr: params.amount_inr,
      currency: "INR",
      description: params.description,
      referenceId: refId,
      customer: {
        name: params.customer_name,
        email: params.customer_email,
        contact: params.customer_contact,
      },
      notes: { ...(params.checkout_session_id ? { checkout_session_id: params.checkout_session_id } : {}), merchant_id: merchantId },
    });

    const row = await repo.insertPaymentLink({
      id: refId,
      merchantId,
      checkoutSessionId: params.checkout_session_id ?? null,
      razorpayPaymentLinkId: (rzpLink as any).id,
      shortUrl: (rzpLink as any).short_url,
      amountInr: params.amount_inr,
      description: params.description,
      status: "created",
    });

    await writeAudit(merchantId, {
      intent_id: params.checkout_session_id ?? refId,
      step: "PAYMENT_LINK_CREATED",
      outcome: "PASS",
      actor: "payment_links",
      reason: `Razorpay payment link ${row.razorpayPaymentLinkId} created for ₹${params.amount_inr} as a recovery path`,
      detail: { razorpay_payment_link_id: row.razorpayPaymentLinkId, short_url: row.shortUrl },
    });

    return { ok: true, link: toDomain(row) };
  } catch (err: any) {
    await writeAudit(merchantId, {
      intent_id: params.checkout_session_id ?? refId,
      step: "PAYMENT_LINK_CREATED",
      outcome: "FAIL",
      actor: "payment_links",
      reason: `Razorpay payment link creation failed: ${err?.message ?? String(err)}`,
      detail: { error: err?.message ?? String(err) },
    });
    return { ok: false, error: `Razorpay payment link creation failed: ${err?.message ?? String(err)}`, httpStatus: 502 };
  }
}

export async function markPaymentLinkStatus(merchantId: string, id: string, status: PaymentLinkRecord["status"]) {
  const row = await repo.updateStatusByIdOrRzpId(merchantId, id, status);
  return row ? toDomain(row) : undefined;
}
