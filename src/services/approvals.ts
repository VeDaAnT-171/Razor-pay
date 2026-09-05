/**
 * src/services/approvals.ts
 *
 * Real, merchant-scoped approval semantics (spec section 53). A
 * REQUIRES_HUMAN session shows up here; approve/reject/modify actually
 * change the session:
 *  - approve: moves the session APPROVED -> ORDER_CREATED (creates the
 *    real Razorpay order at that point, same as the auto-approved path).
 *  - reject: moves the session to REJECTED, terminal.
 *  - modify: raises/lowers the session's authorization_inr, re-runs the
 *    guardrail check against the NEW limit, and only proceeds to
 *    ORDER_CREATED if the modified limit actually covers the cart.
 */

import { randomUUID } from "crypto";
import { getSession, transitionSession } from "./checkout_session";
import { writeAudit } from "./audit_log";
import { createRazorpayOrder } from "./razorpay_client";
import { releaseHoldsForSession, DEFAULT_HOLD_TTL_SEC } from "./inventory";
import * as repo from "../db/approvals";

export interface ApprovalRecord {
  approval_id: string;
  checkout_session_id: string;
  kind: "limit" | "discount" | "substitution" | "category";
  title: string;
  reason: string;
  amount_inr: number;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  resolved_at?: string;
}

function toDomain(row: repo.ApprovalRow): ApprovalRecord {
  return {
    approval_id: row.id,
    checkout_session_id: row.checkoutSessionId,
    kind: row.kind as ApprovalRecord["kind"],
    title: row.title,
    reason: row.reason,
    amount_inr: row.amountInr,
    status: row.status as ApprovalRecord["status"],
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : undefined,
  };
}

export async function createApproval(
  merchantId: string,
  params: Omit<ApprovalRecord, "approval_id" | "status" | "created_at">
): Promise<ApprovalRecord> {
  const row = await repo.insertApproval({
    id: `appr_${randomUUID()}`,
    merchantId,
    checkoutSessionId: params.checkout_session_id,
    kind: params.kind,
    title: params.title,
    reason: params.reason,
    amountInr: params.amount_inr,
    status: "pending",
  });
  await writeAudit(merchantId, {
    intent_id: params.checkout_session_id,
    step: "APPROVAL_REQUESTED",
    outcome: "INFO",
    actor: "approvals",
    reason: `Human approval requested: ${params.title} — ${params.reason}`,
    detail: { approval_id: row.id, amount_inr: params.amount_inr },
  });
  return toDomain(row);
}

export async function listApprovals(merchantId: string): Promise<ApprovalRecord[]> {
  const rows = await repo.listApprovals(merchantId);
  return rows.map(toDomain);
}

export async function resolveApproval(
  merchantId: string,
  approvalId: string,
  action: "approve" | "reject" | "modify",
  modifiedLimitInr?: number,
  note?: string
): Promise<{ ok: true; approval: ApprovalRecord } | { ok: false; error: string; httpStatus: number }> {
  const approvalRow = await repo.findApproval(merchantId, approvalId);
  if (!approvalRow) return { ok: false, error: "Unknown approval_id", httpStatus: 404 };
  if (approvalRow.status !== "pending") return { ok: false, error: `Approval already ${approvalRow.status}`, httpStatus: 409 };

  const session = await getSession(merchantId, approvalRow.checkoutSessionId);
  if (!session) return { ok: false, error: "Underlying checkout session no longer exists", httpStatus: 404 };

  if (action === "reject") {
    const updated = await repo.updateApproval(merchantId, approvalId, { status: "rejected", resolvedAt: new Date() });
    await transitionSession(merchantId, session.checkout_session_id, "REJECTED", "approvals", `Approval rejected by merchant${note ? `: ${note}` : ""}`);
    await releaseHoldsForSession(merchantId, session.checkout_session_id, `Approval rejected by merchant${note ? `: ${note}` : ""}`, session.intent_id);
    await writeAudit(merchantId, {
      intent_id: session.intent_id, step: "APPROVAL_REJECTED", outcome: "FAIL", actor: "approvals",
      reason: `Approval ${approvalId} rejected${note ? `: ${note}` : ""}`, detail: { approval_id: approvalId },
    });
    return { ok: true, approval: toDomain(updated!) };
  }

  let effectiveLimit = session.authorization_inr;
  if (action === "modify") {
    if (!modifiedLimitInr || modifiedLimitInr <= 0) {
      return { ok: false, error: "modified_limit_inr required and must be positive for action=modify", httpStatus: 400 };
    }
    effectiveLimit = modifiedLimitInr;
    await writeAudit(merchantId, {
      intent_id: session.intent_id, step: "AUTHORIZATION_MODIFIED", outcome: "INFO", actor: "approvals",
      reason: `Authorization modified from ₹${session.authorization_inr} to ₹${modifiedLimitInr} by merchant${note ? `: ${note}` : ""}`,
      detail: { approval_id: approvalId, previous_limit_inr: session.authorization_inr, new_limit_inr: modifiedLimitInr },
    });
  }

  if (session.final_amount_inr > effectiveLimit) {
    return { ok: false, error: `Cart total ₹${session.final_amount_inr} still exceeds authorization ₹${effectiveLimit} — cannot approve`, httpStatus: 422 };
  }

  const updated = await repo.updateApproval(merchantId, approvalId, { status: "approved", resolvedAt: new Date() });
  await writeAudit(merchantId, {
    intent_id: session.intent_id, step: "APPROVAL_APPROVED", outcome: "PASS", actor: "approvals",
    reason: `Approval ${approvalId} approved by merchant — authorization ₹${effectiveLimit} covers cart ₹${session.final_amount_inr}`,
    detail: { approval_id: approvalId },
  });

  await transitionSession(merchantId, session.checkout_session_id, "APPROVED", "approvals", "Merchant approved — proceeding to settlement",
    { authorization_inr: effectiveLimit, policy_decision: "APPROVED" });

  try {
    const order = await createRazorpayOrder({
      amountInr: session.final_amount_inr,
      currency: session.currency,
      receipt: session.intent_id,
      notes: { checkout_session_id: session.checkout_session_id, source: "human_approval", merchant_id: merchantId },
    });
    const paymentWindowExpiresAt = new Date(Date.now() + DEFAULT_HOLD_TTL_SEC * 1000).toISOString();
    await transitionSession(merchantId, session.checkout_session_id, "ORDER_CREATED", "approvals",
      `Razorpay order ${(order as any).id} created after human approval`,
      { razorpay_order_id: (order as any).id, order_status: "CREATED", expires_at: paymentWindowExpiresAt });
    await writeAudit(merchantId, {
      intent_id: session.intent_id, step: "ORDER_CREATED", outcome: "PASS", actor: "approvals",
      reason: `Razorpay order ${(order as any).id} created for ₹${session.final_amount_inr} following approval`,
      detail: { razorpay_order_id: (order as any).id },
    });
  } catch (err: any) {
    await transitionSession(merchantId, session.checkout_session_id, "CANCELLED", "approvals", `Razorpay order creation failed after approval: ${err?.message ?? String(err)}`);
    await releaseHoldsForSession(merchantId, session.checkout_session_id, `Razorpay order creation failed after approval: ${err?.message ?? String(err)}`, session.intent_id);
    await writeAudit(merchantId, {
      intent_id: session.intent_id, step: "FAILURE", outcome: "FAIL", actor: "approvals",
      reason: `Razorpay order creation failed after approval: ${err?.message ?? String(err)}`,
      detail: { error: err?.message ?? String(err) },
    });
    return { ok: false, error: `Approved, but Razorpay order creation failed: ${err?.message ?? String(err)}`, httpStatus: 502 };
  }

  return { ok: true, approval: toDomain(updated!) };
}
