/**
 * src/services/dev_tools.ts
 *
 * A Razorpay Order created via the Orders API is not paid until a human
 * (or the Razorpay Checkout widget) actually completes payment, at which
 * point Razorpay fires a signed webhook. This sandbox has no public URL
 * for Razorpay to deliver that webhook to, and no browser-based Checkout
 * flow — so there is no way to produce a *real* PAYMENT_CAPTURED short of
 * deploying this backend somewhere reachable and completing a real test
 * payment (see README "Going from ORDER_CREATED to a real PAYMENT_CAPTURED").
 *
 * This function exists ONLY so the demo can show the rest of the
 * lifecycle end-to-end. It is explicitly, permanently labeled: every
 * session it touches is flagged `simulated_payment: true` for the rest of
 * its life, every audit entry it writes uses the SIMULATED_PAYMENT_EVENT
 * step (never PAYMENT_CAPTURED, which is reserved for the real webhook
 * path in webhooks.ts), and `isPaid()` in checkout_session.ts returns
 * false for any session this touches — so nothing downstream (refunds,
 * revenue analytics) can mistake it for real captured money.
 */

import { getSession, transitionSession } from "./checkout_session";
import { writeAudit } from "./audit_log";
import { consumeHoldsForSession, releaseHoldsForSession } from "./inventory";

export async function simulateTestPayment(
  merchantId: string,
  sessionId: string,
  outcome: "capture" | "fail" = "capture"
): Promise<{ ok: true; session: Awaited<ReturnType<typeof getSession>> } | { ok: false; error: string; httpStatus: number }> {
  const session = await getSession(merchantId, sessionId);
  if (!session) return { ok: false, error: "Unknown checkout_session_id", httpStatus: 404 };
  if (session.state !== "ORDER_CREATED") {
    return { ok: false, error: `Session is in state ${session.state}, not ORDER_CREATED — nothing to simulate payment against`, httpStatus: 409 };
  }

  await transitionSession(merchantId, sessionId, "PAYMENT_INITIATED", "dev_tools:simulate", "SIMULATED — Test Lab initiated a simulated payment", { simulated_payment: true, payment_status: "INITIATED" });
  await writeAudit(merchantId, {
    intent_id: session.intent_id, step: "SIMULATED_PAYMENT_EVENT", outcome: "INFO", actor: "dev_tools:simulate",
    reason: "SIMULATED — no real Razorpay payment was attempted; this sandbox cannot receive a live webhook.",
    detail: { checkout_session_id: sessionId },
  });

  if (outcome === "fail") {
    const updated = await transitionSession(merchantId, sessionId, "PAYMENT_FAILED", "dev_tools:simulate", "SIMULATED payment failure", { payment_status: "FAILED" });
    await releaseHoldsForSession(merchantId, sessionId, "SIMULATED payment failed — released held stock back to the pool", session.intent_id);
    await writeAudit(merchantId, {
      intent_id: session.intent_id, step: "SIMULATED_PAYMENT_EVENT", outcome: "FAIL", actor: "dev_tools:simulate",
      reason: "SIMULATED payment failed — no real money was ever at risk.", detail: { checkout_session_id: sessionId },
    });
    return { ok: true, session: updated };
  }

  await transitionSession(merchantId, sessionId, "PAYMENT_AUTHORIZED", "dev_tools:simulate", "SIMULATED payment authorized", { payment_status: "AUTHORIZED" });
  await transitionSession(merchantId, sessionId, "PAYMENT_CAPTURED", "dev_tools:simulate", "SIMULATED payment captured — NOT real Razorpay money movement",
    { payment_status: "CAPTURED", razorpay_payment_id: `pay_SIMULATED_${sessionId.slice(3, 11)}` });
  const paid = await transitionSession(merchantId, sessionId, "ORDER_PAID", "dev_tools:simulate", "SIMULATED — order marked paid", { order_status: "PAID" });
  await consumeHoldsForSession(merchantId, sessionId, session.intent_id);

  await writeAudit(merchantId, {
    intent_id: session.intent_id, step: "SIMULATED_PAYMENT_EVENT", outcome: "PASS", actor: "dev_tools:simulate",
    reason: "SIMULATED payment captured for demo purposes. This did NOT move real money and is flagged simulated_payment=true permanently on this session.",
    detail: { checkout_session_id: sessionId, amount_inr: session.final_amount_inr },
  });

  return { ok: true, session: paid };
}
