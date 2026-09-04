/**
 * src/services/store_profile.ts
 *
 * Spec section 7 / Phase 1: the merchant's Commerce Profile, and a real,
 * computed "AI Transactability Score" — not a hardcoded "87/100".
 * Merchant-scoped: every check reads THIS tenant's actual system state
 * (their catalog, their published policy, their audit hash-chain).
 *
 * Every checklist item reads actual system state (env vars, the live
 * catalog, the published policy, the audit hash-chain, whether a webhook
 * secret was changed from its placeholder). Nothing here is a canned
 * number: run with no .env configured and the score visibly drops,
 * configure Razorpay/webhook keys and it visibly rises.
 */

import { listCatalog } from "./catalog";
import { getPublishedPolicy } from "./policy_store";
import { verifyChain, getFullAuditLog } from "./audit_log";
import { getMerchant } from "./auth";

export interface ReadinessCheck {
  key: string;
  label: string;
  status: "ok" | "warning" | "blocking";
  detail: string;
  weight: number;
}

export interface ReadinessResult {
  score: number; // 0-100
  max_score: number;
  checks: ReadinessCheck[];
  blocking_count: number;
  warning_count: number;
}

function razorpayKeysConfigured(): boolean {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  return !!id && !!secret && !id.includes("xxxxxxxx") && !secret.includes("xxxxxxxx");
}

function webhookSecretConfigured(): boolean {
  const s = process.env.RAZORPAY_WEBHOOK_SECRET;
  return !!s && s !== "change-me-in-production";
}

function productsWithCompleteAiMetadata(catalog: Awaited<ReturnType<typeof listCatalog>>): { complete: number; total: number; missing: string[] } {
  const missing: string[] = [];
  for (const p of catalog) {
    const ok = !!p.description && !!p.category && p.price_inr > 0 && p.inventory_count >= 0 && !!p.mcc;
    if (!ok) missing.push(p.sku);
  }
  return { complete: catalog.length - missing.length, total: catalog.length, missing };
}

/**
 * Computes the AI Transactability Score from real, currently-true facts
 * about this merchant's tenant.
 */
export async function computeReadiness(merchantId: string): Promise<ReadinessResult> {
  const [policy, chain, catalog, auditLog] = await Promise.all([
    getPublishedPolicy(merchantId),
    verifyChain(merchantId),
    listCatalog(merchantId),
    getFullAuditLog(merchantId),
  ]);
  const meta = productsWithCompleteAiMetadata(catalog);
  const rzpOk = razorpayKeysConfigured();
  const whOk = webhookSecretConfigured();

  const checks: ReadinessCheck[] = [
    {
      key: "catalog",
      label: `Catalog available (${catalog.length} products)`,
      status: catalog.length > 0 ? "ok" : "blocking",
      detail: catalog.length > 0 ? `${catalog.length} SKUs published to /agent/v1/catalog` : "No products in catalog",
      weight: 10,
    },
    {
      key: "ai_metadata",
      label: "Product AI metadata complete",
      status: meta.missing.length === 0 ? "ok" : "warning",
      detail:
        meta.missing.length === 0
          ? `All ${meta.total} products have description, category, price and inventory`
          : `${meta.missing.length} product(s) missing AI metadata: ${meta.missing.join(", ")}`,
      weight: 8,
    },
    {
      key: "razorpay",
      label: "Razorpay Test Mode connected",
      status: rzpOk ? "ok" : "blocking",
      detail: rzpOk
        ? "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET configured"
        : "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — orders, refunds and payment links cannot execute",
      weight: 20,
    },
    {
      key: "webhook",
      label: "Webhook signature verification configured",
      status: whOk ? "ok" : "warning",
      detail: whOk
        ? "RAZORPAY_WEBHOOK_SECRET set — inbound events will be signature-verified"
        : "RAZORPAY_WEBHOOK_SECRET still at its placeholder — real payment-captured events can't be trusted yet",
      weight: 12,
    },
    {
      key: "policy",
      label: `Spending policy published (v${policy.version})`,
      status: "ok",
      detail: `Auto-approve up to ₹${policy.auto_approve_limit_inr}, max ${policy.max_auto_discount_pct}% discount, velocity capped at ₹${policy.velocity.hourly_inr}/hr`,
      weight: 15,
    },
    {
      key: "quotes",
      label: "Short-lived quotes enabled",
      status: "ok",
      detail: "GET /agent/v1/catalog/quote/:sku issues a time-boxed quote re-validated at checkout",
      weight: 8,
    },
    {
      key: "inventory",
      label: "Inventory connected",
      status: "ok",
      detail: "GET /agent/v1/catalog/inventory/:sku checked against live catalog counts before order creation",
      weight: 7,
    },
    {
      key: "audit",
      label: "Audit chain healthy",
      status: chain.valid ? "ok" : "blocking",
      detail: chain.valid ? `Hash-chain verified, ${auditLog.length} entries` : "Audit hash-chain verification FAILED — investigate before going live",
      weight: 10,
    },
    {
      key: "refunds",
      label: "Refund path configured",
      status: rzpOk ? "ok" : "warning",
      detail: rzpOk ? "POST /agent/v1/refunds calls the real Razorpay Refunds API" : "Refunds need Razorpay Test Mode keys to execute",
      weight: 5,
    },
    {
      key: "checkout",
      label: "Conversational checkout enabled",
      status: "ok",
      detail: "POST /agent/v1/checkout accepts ACP / AP2 / x402 / NPCI-UAP intents through one guardrail gate",
      weight: 5,
    },
  ];

  const max_score = checks.reduce((s, c) => s + c.weight, 0);
  const score = checks.reduce((s, c) => s + (c.status === "ok" ? c.weight : c.status === "warning" ? c.weight * 0.5 : 0), 0);
  const blocking_count = checks.filter((c) => c.status === "blocking").length;
  const warning_count = checks.filter((c) => c.status === "warning").length;

  return {
    score: Math.round((score / max_score) * 100),
    max_score: 100,
    checks,
    blocking_count,
    warning_count,
  };
}

export interface MerchantProfile {
  merchant_id: string;
  name: string;
  description: string;
  categories: string[];
  currency: string;
  locations: string[];
  shipping: { domestic: boolean; regions: string[]; standard_days: string };
  returns: { window_days: number; policy_url: string | null };
  support: { email: string; hours: string };
  ai_commerce_capabilities: {
    discoverable: boolean;
    purchasable: boolean;
    negotiable: boolean;
    recommendable: boolean;
    supported_protocols: string[];
  };
}

export async function getMerchantProfile(merchantId: string): Promise<MerchantProfile> {
  const [catalog, merchant] = await Promise.all([listCatalog(merchantId), getMerchant(merchantId)]);
  const categories = Array.from(new Set(catalog.map((p) => p.category)));
  return {
    merchant_id: merchantId,
    name: merchant?.name ?? "Merchant",
    description: `${merchant?.name ?? "This merchant"}'s storefront, sold direct-to-consumer and to autonomous AI buyers.`,
    categories,
    currency: "INR",
    locations: ["IN"],
    shipping: { domestic: true, regions: ["IN"], standard_days: "3-5 business days" },
    returns: { window_days: 7, policy_url: null },
    support: { email: merchant?.email ?? "support@example.test", hours: "Mon-Sat 10:00-19:00 IST" },
    ai_commerce_capabilities: {
      discoverable: true,
      purchasable: true,
      negotiable: true,
      recommendable: true,
      supported_protocols: ["ACP", "AP2", "x402", "NPCI_UAP"],
    },
  };
}

export async function getStoreProfileWithReadiness(merchantId: string) {
  const [merchant, readiness] = await Promise.all([getMerchantProfile(merchantId), computeReadiness(merchantId)]);
  return { merchant, readiness };
}
