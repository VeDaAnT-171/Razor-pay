/**
 * src/services/razorpay_client.ts
 *
 * Thin wrapper around the official `razorpay` Node SDK, lazily
 * instantiated so the app can boot (and its non-payment routes work)
 * even before RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are configured.
 * Every A-COS checkout ultimately lands here as a Razorpay Orders API
 * call — this is the seam where any protocol's mandate becomes a real
 * (test-mode) payment.
 */

import Razorpay from "razorpay";

let client: Razorpay | null = null;

export function getRazorpayClient(): Razorpay {
  if (client) return client;

  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret || key_id.includes("xxxx")) {
    throw new Error(
      "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured. Copy .env.example to .env and " +
        "fill in your Razorpay Test Mode keys from https://dashboard.razorpay.com/app/keys."
    );
  }

  client = new Razorpay({ key_id, key_secret });
  return client;
}

export interface CreateOrderParams {
  amountInr: number;
  currency: "INR";
  receipt: string;
  notes: Record<string, string>;
}

/**
 * Creates a Razorpay Order in test mode. Amount is converted from rupees
 * to paise as the Orders API requires. Returns the raw Razorpay order
 * object on success.
 */
export async function createRazorpayOrder(params: CreateOrderParams) {
  const rzp = getRazorpayClient();
  const order = await rzp.orders.create({
    amount: Math.round(params.amountInr * 100), // paise
    currency: params.currency,
    receipt: params.receipt,
    notes: params.notes,
  });
  return order;
}

export interface CreateRefundParams {
  paymentId: string;
  amountInr?: number; // omit = full refund
  notes?: Record<string, string>;
}

/** Real Razorpay Refunds API call. Requires a captured payment_id — a refund cannot exist without one. */
export async function createRazorpayRefund(params: CreateRefundParams) {
  const rzp = getRazorpayClient();
  const payload: Record<string, unknown> = { notes: params.notes ?? {} };
  if (typeof params.amountInr === "number") payload.amount = Math.round(params.amountInr * 100);
  const refund = await rzp.payments.refund(params.paymentId, payload as any);
  return refund;
}

export interface CreatePaymentLinkParams {
  amountInr: number;
  currency: "INR";
  description: string;
  referenceId: string;
  customer?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
}

/** Real Razorpay Payment Links API call — used as the graceful-recovery path when autonomous checkout can't complete. */
export async function createRazorpayPaymentLink(params: CreatePaymentLinkParams) {
  const rzp = getRazorpayClient();
  const link = await rzp.paymentLink.create({
    amount: Math.round(params.amountInr * 100),
    currency: params.currency,
    description: params.description,
    reference_id: params.referenceId,
    customer: params.customer,
    notify: { sms: false, email: false },
    notes: params.notes ?? {},
  } as any);
  return link;
}
