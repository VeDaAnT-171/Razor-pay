/**
 * src/services/policy_store.ts
 *
 * Module 4 upgrade — Policy v2, now merchant-scoped and Postgres-backed.
 * Replaces the single hardcoded GuardrailPolicy with a versioned policy
 * object (draft -> publish, each publish gets a new version number) per
 * tenant, plus velocity (hourly/daily/monthly spend + transaction-count),
 * category allow/block lists, an absolute discount ceiling, and a
 * payment-method allow/block list. All of these actually gate
 * `runGuardrailGate()` in guardrail_gate.ts — nothing here is decorative.
 *
 * Velocity counters are tracked per (merchant, buyer_agent_id) with a real
 * rolling window in Postgres, so "₹X/hour" is an enforced number, not a
 * label.
 */

import { PolicyV2, AgentProfile } from "../schema/types";
import * as repo from "../db/policy";

/* ------------------------------------------------------------------ */
/* Row <-> domain mapping                                               */
/* ------------------------------------------------------------------ */

function toPolicyV2(row: repo.PolicyRow): PolicyV2 {
  return {
    version: row.version,
    status: row.status as "draft" | "published",
    auto_approve_limit_inr: row.autoApproveLimitInr,
    velocity: row.velocity as PolicyV2["velocity"],
    allowed_categories: row.allowedCategories as string[],
    blocked_categories: row.blockedCategories as string[],
    max_quantity_per_item: row.maxQuantityPerItem,
    max_auto_discount_pct: row.maxAutoDiscountPct,
    max_absolute_discount_inr: row.maxAbsoluteDiscountInr ?? undefined,
    allowed_payment_methods: row.allowedPaymentMethods as string[],
    blocked_payment_methods: row.blockedPaymentMethods as string[],
    new_customer_limit_inr: row.newCustomerLimitInr ?? undefined,
    human_approval_new_category: row.humanApprovalNewCategory,
    human_approval_address_change: row.humanApprovalAddressChange,
    human_approval_payment_method_change: row.humanApprovalPaymentMethodChange,
    created_at: row.createdAt.toISOString(),
    published_at: row.publishedAt ? row.publishedAt.toISOString() : undefined,
  };
}

function toRowValues(p: PolicyV2): repo.PolicyInsert {
  return {
    version: p.version,
    status: p.status,
    autoApproveLimitInr: p.auto_approve_limit_inr,
    velocity: p.velocity,
    allowedCategories: p.allowed_categories,
    blockedCategories: p.blocked_categories,
    maxQuantityPerItem: p.max_quantity_per_item,
    maxAutoDiscountPct: p.max_auto_discount_pct,
    maxAbsoluteDiscountInr: p.max_absolute_discount_inr ?? null,
    allowedPaymentMethods: p.allowed_payment_methods,
    blockedPaymentMethods: p.blocked_payment_methods,
    newCustomerLimitInr: p.new_customer_limit_inr ?? null,
    humanApprovalNewCategory: p.human_approval_new_category,
    humanApprovalAddressChange: p.human_approval_address_change,
    humanApprovalPaymentMethodChange: p.human_approval_payment_method_change,
    publishedAt: p.published_at ? new Date(p.published_at) : null,
  };
}

/** The defaults every newly-signed-up merchant's Policy v1 is seeded with — identical to the old single-tenant hardcoded values. */
function defaultPolicyV1(): PolicyV2 {
  const now = new Date().toISOString();
  return {
    version: 1,
    status: "published",
    auto_approve_limit_inr: Number(process.env.DEFAULT_AUTO_LIMIT_INR ?? 1500),
    velocity: {
      per_transaction_inr: 5000,
      hourly_inr: 10000,
      daily_inr: 15000,
      monthly_inr: 50000,
      max_transactions_per_hour: 8,
      max_transactions_per_day: 25,
      max_failed_attempts_per_hour: 5,
    },
    allowed_categories: ["Electronics > Audio", "Electronics > Accessories"],
    blocked_categories: ["Gift Cards", "Electronics > High-Value"],
    max_quantity_per_item: 3,
    max_auto_discount_pct: Number(process.env.MAX_AUTO_DISCOUNT_PCT ?? 10),
    max_absolute_discount_inr: 500,
    allowed_payment_methods: ["card", "upi", "netbanking", "wallet"],
    blocked_payment_methods: [],
    new_customer_limit_inr: 1000,
    human_approval_new_category: true,
    human_approval_address_change: true,
    human_approval_payment_method_change: true,
    created_at: now,
    published_at: now,
  };
}

/** Called once, at merchant signup. */
export async function seedMerchantPolicy(merchantId: string): Promise<void> {
  await repo.insertPolicy(merchantId, toRowValues(defaultPolicyV1()));
}

export async function getPublishedPolicy(merchantId: string): Promise<PolicyV2> {
  const row = await repo.findPublishedPolicy(merchantId);
  if (!row) {
    // Should never happen for a merchant created through signup(), but fail
    // safe with an in-memory default rather than crashing the request.
    return defaultPolicyV1();
  }
  return toPolicyV2(row);
}

export async function getDraftPolicy(merchantId: string): Promise<PolicyV2> {
  const draft = await repo.findDraftPolicy(merchantId);
  if (draft) return toPolicyV2(draft);
  const published = await getPublishedPolicy(merchantId);
  return { ...published, status: "draft" };
}

export async function saveDraft(merchantId: string, patch: Partial<PolicyV2>): Promise<PolicyV2> {
  const base = await getDraftPolicy(merchantId);
  const published = await getPublishedPolicy(merchantId);
  const next: PolicyV2 = { ...base, ...patch, version: published.version, status: "draft" };

  await repo.deleteDraftPolicy(merchantId);
  const row = await repo.insertPolicy(merchantId, {
    ...toRowValues(next),
    version: repo.DRAFT_VERSION_SENTINEL,
  });
  return toPolicyV2({ ...row, version: next.version }); // report the real "would-be" version to the caller
}

export async function publishDraft(merchantId: string): Promise<PolicyV2> {
  const draft = await repo.findDraftPolicy(merchantId);
  const published = await getPublishedPolicy(merchantId);
  const source = draft ? toPolicyV2(draft) : published;

  const next: PolicyV2 = {
    ...source,
    version: published.version + 1,
    status: "published",
    created_at: source.created_at ?? new Date().toISOString(),
    published_at: new Date().toISOString(),
  };

  await repo.insertPolicy(merchantId, toRowValues(next));
  await repo.deleteDraftPolicy(merchantId);
  return next;
}

export async function getPolicyHistory(merchantId: string): Promise<PolicyV2[]> {
  const rows = await repo.listPublishedHistory(merchantId);
  return rows.map(toPolicyV2);
}

/* ------------------------------------------------------------------ */
/* Agent permission profiles                                           */
/* ------------------------------------------------------------------ */

export async function getAgentProfile(merchantId: string, agentId: string): Promise<AgentProfile> {
  const existing = await repo.findAgentProfile(merchantId, agentId);
  if (existing) {
    return {
      agent_id: existing.agentId,
      verified: existing.verified,
      protocol: existing.protocol,
      per_transaction_inr: existing.perTransactionInr,
      hourly_inr: existing.hourlyInr,
      daily_inr: existing.dailyInr,
      monthly_inr: existing.monthlyInr,
      discount_authority_pct: existing.discountAuthorityPct,
      max_quantity: existing.maxQuantity,
      allowed_categories: existing.allowedCategories as string[],
      restricted_categories: existing.restrictedCategories as string[],
    };
  }

  const policy = await getPublishedPolicy(merchantId);
  const created = await repo.insertAgentProfile(merchantId, {
    agentId,
    verified: true,
    protocol: "unknown",
    perTransactionInr: policy.velocity.per_transaction_inr ?? 5000,
    hourlyInr: policy.velocity.hourly_inr ?? 10000,
    dailyInr: policy.velocity.daily_inr ?? 15000,
    monthlyInr: policy.velocity.monthly_inr ?? 50000,
    discountAuthorityPct: policy.max_auto_discount_pct,
    maxQuantity: policy.max_quantity_per_item,
    allowedCategories: policy.allowed_categories,
    restrictedCategories: policy.blocked_categories,
  });

  return {
    agent_id: created.agentId,
    verified: created.verified,
    protocol: created.protocol,
    per_transaction_inr: created.perTransactionInr,
    hourly_inr: created.hourlyInr,
    daily_inr: created.dailyInr,
    monthly_inr: created.monthlyInr,
    discount_authority_pct: created.discountAuthorityPct,
    max_quantity: created.maxQuantity,
    allowed_categories: created.allowedCategories as string[],
    restricted_categories: created.restrictedCategories as string[],
  };
}

/* ------------------------------------------------------------------ */
/* Velocity tracking — real rolling counters per (merchant, agent)     */
/* ------------------------------------------------------------------ */

export async function recordVelocityEvent(merchantId: string, agentId: string, amountInr: number, failed: boolean): Promise<void> {
  await repo.insertVelocityEvent(merchantId, agentId, amountInr, failed);
}

export interface VelocityCheckResult {
  pass: boolean;
  failures: string[];
  usage: {
    hour_spent_inr: number;
    day_spent_inr: number;
    month_spent_inr: number;
    hour_count: number;
    day_count: number;
    hour_failed_count: number;
  };
}

export async function checkVelocity(merchantId: string, agentId: string, attemptedAmountInr: number, policy: PolicyV2): Promise<VelocityCheckResult> {
  const failures: string[] = [];
  const HOUR = 60 * 60 * 1000;
  const [hour, day, month, hourFailed] = await Promise.all([
    repo.windowSum(merchantId, agentId, HOUR),
    repo.windowSum(merchantId, agentId, 24 * HOUR),
    repo.windowSum(merchantId, agentId, 30 * 24 * HOUR),
    repo.windowSum(merchantId, agentId, HOUR, true),
  ]);

  const v = policy.velocity;
  if (v.per_transaction_inr && attemptedAmountInr > v.per_transaction_inr) {
    failures.push(`₹${attemptedAmountInr} exceeds per-transaction limit ₹${v.per_transaction_inr}`);
  }
  if (v.hourly_inr && hour.sumInr + attemptedAmountInr > v.hourly_inr) {
    failures.push(`Hourly spend would reach ₹${hour.sumInr + attemptedAmountInr}, exceeding ₹${v.hourly_inr}/hr limit`);
  }
  if (v.daily_inr && day.sumInr + attemptedAmountInr > v.daily_inr) {
    failures.push(`Daily spend would reach ₹${day.sumInr + attemptedAmountInr}, exceeding ₹${v.daily_inr}/day limit`);
  }
  if (v.monthly_inr && month.sumInr + attemptedAmountInr > v.monthly_inr) {
    failures.push(`Monthly spend would reach ₹${month.sumInr + attemptedAmountInr}, exceeding ₹${v.monthly_inr}/mo limit`);
  }
  if (v.max_transactions_per_hour && hour.count + 1 > v.max_transactions_per_hour) {
    failures.push(`${hour.count + 1} transactions this hour exceeds cap of ${v.max_transactions_per_hour}/hr`);
  }
  if (v.max_transactions_per_day && day.count + 1 > v.max_transactions_per_day) {
    failures.push(`${day.count + 1} transactions today exceeds cap of ${v.max_transactions_per_day}/day`);
  }
  if (v.max_failed_attempts_per_hour && hourFailed.count >= v.max_failed_attempts_per_hour) {
    failures.push(`${hourFailed.count} failed attempts this hour reached the safety cap of ${v.max_failed_attempts_per_hour}`);
  }

  return {
    pass: failures.length === 0,
    failures,
    usage: {
      hour_spent_inr: hour.sumInr,
      day_spent_inr: day.sumInr,
      month_spent_inr: month.sumInr,
      hour_count: hour.count,
      day_count: day.count,
      hour_failed_count: hourFailed.count,
    },
  };
}

export async function resetVelocityForTests(merchantId: string): Promise<void> {
  await repo.clearVelocityEventsForMerchant(merchantId);
}
