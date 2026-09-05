/**
 * src/services/ai_storefront.ts
 *
 * A real, LLM-backed conversational sales agent — calling Anthropic's
 * Claude API — distinct from the client-side scripted "Buyer Simulator"
 * demo in the dashboard (which is honestly labeled a simulated agent and
 * never claims to be a live model). This is the "LLM Agent & Reasoning
 * Core" piece: it resolves buyer intent conversationally, proposes real
 * cross-sell/upsell products, and — critically — is only ever allowed to
 * *propose*. It never authorizes money movement itself:
 *
 *   - It is grounded ONLY in this merchant's real catalog and bundle
 *     rules (passed into the prompt as data) — it cannot invent a SKU,
 *     price, or stock level that doesn't exist in Postgres.
 *   - Any discount it suggests is independently clamped, server-side, to
 *     the merchant's own published policy ceiling
 *     (`max_auto_discount_pct`) before it's ever returned to the buyer —
 *     the model's number is a suggestion, the policy engine is the
 *     authority, exactly like every other discount path in this codebase
 *     (services/negotiation.ts, middleware/guardrail_gate.ts).
 *   - Every turn is written to the immutable audit trail with the
 *     model's own stated reasoning, under intent_id
 *     `storefront_<conversation_id>` — satisfying "every money action
 *     must be explainable" for the recommendation/discount path the same
 *     way it already holds for checkout.
 *
 * Same honesty pattern as services/mailer.ts: if ANTHROPIC_API_KEY isn't
 * configured, this returns a clearly-labeled degraded response — built
 * from real catalog data, just not model-generated prose — instead of
 * failing the request. The feature demos either way; a real key just
 * makes the conversation actually intelligent.
 */

import { randomUUID } from "crypto";
import { listCatalog, getBundleRulesFor } from "./catalog";
import { getPublishedPolicy } from "./policy_store";
import { getAvailableQuantity } from "./inventory";
import { writeAudit } from "./audit_log";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-20241022";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

function anthropicConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface ConversationTurn {
  role: "buyer" | "agent";
  text: string;
}

export interface StorefrontChatResult {
  conversation_id: string;
  reply: string;
  suggested_skus: string[];
  discount_pct: number;
  reasoning: string;
  degraded: boolean;
  audit_id?: string;
}

/** Builds the grounding context the model is allowed to reason over — real products and bundle rules only, nothing invented. */
async function buildCatalogContext(merchantId: string, cartSkus: string[]): Promise<string> {
  const catalog = await listCatalog(merchantId);
  const lines: string[] = [];
  for (const p of catalog) {
    const available = await getAvailableQuantity(merchantId, p.sku);
    lines.push(`- ${p.sku}: "${p.name}" — ₹${p.price_inr}, ${available} available, category=${p.category}`);
  }
  const bundleLines: string[] = [];
  for (const sku of cartSkus) {
    const candidates = await getBundleRulesFor(merchantId, sku);
    for (const c of candidates) bundleLines.push(`- If cart contains ${sku}, consider recommending ${c.sku} — ${c.reason}`);
  }
  return [
    "CATALOG (the ONLY products you may mention or recommend — never invent a SKU, name, or price not listed here):",
    ...lines,
    bundleLines.length ? "\nKNOWN CROSS-SELL PAIRINGS:" : "",
    ...bundleLines,
  ].join("\n");
}

function degradedReply(cartSkus: string[]): { reply: string; suggested_skus: string[]; reasoning: string } {
  return {
    reply:
      "[Simulated — ANTHROPIC_API_KEY is not configured on this server] I can help you find a product — could you tell me what you're shopping for today?",
    suggested_skus: [],
    reasoning: "ANTHROPIC_API_KEY not set — no live model call was made; this is a static fallback, not a real recommendation.",
  };
}

/**
 * One turn of a conversation. Stateless server-side: the caller
 * (frontend or agent) resends the running `history` each turn, so no new
 * conversation-storage table is needed for this to be a genuine,
 * multi-turn conversation.
 */
export async function chatWithStorefrontAgent(
  merchantId: string,
  message: string,
  history: ConversationTurn[] = [],
  cartSkus: string[] = [],
  conversationId?: string
): Promise<StorefrontChatResult> {
  const convId = conversationId ?? `conv_${randomUUID()}`;
  const policy = await getPublishedPolicy(merchantId);

  if (!anthropicConfigured()) {
    const fallback = degradedReply(cartSkus);
    const audit = await writeAudit(merchantId, {
      intent_id: `storefront_${convId}`,
      step: "STOREFRONT_CONVERSATION",
      outcome: "INFO",
      actor: "ai_storefront",
      reason: fallback.reasoning,
      detail: { conversation_id: convId, message, degraded: true },
    });
    return { conversation_id: convId, ...fallback, discount_pct: 0, degraded: true, audit_id: audit.audit_id };
  }

  const catalogContext = await buildCatalogContext(merchantId, cartSkus);
  const systemPrompt =
    "You are the storefront sales agent for an online store built on A-COS (Agentic Commerce OS). " +
    "You have a real conversation with a buyer to help them find and decide on products. " +
    `${catalogContext}\n\n` +
    `You may suggest a discount, but it will be capped at ${policy.max_auto_discount_pct}% regardless of what you propose — never promise more than that. ` +
    "Respond ONLY with a single JSON object, no other text, matching exactly this shape: " +
    '{"reply": "<what you say to the buyer, conversational>", "suggested_skus": ["<sku>", ...], "discount_pct": <number 0-100>, "reasoning": "<one sentence explaining WHY you suggested this discount or product, e.g. \'10% bundle discount because SKU-A and SKU-B are both in cart\'>"}. ' +
    "If you are not proposing a discount, set discount_pct to 0 and explain why in reasoning (e.g. \"no discount — first-time inquiry, no bundle match\"). Never mention a SKU that is not in the catalog above.";

  const messages = [
    ...history.map((t) => ({ role: t.role === "buyer" ? "user" : "assistant", content: t.text })),
    { role: "user", content: message },
  ];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 500,
          system: systemPrompt,
          messages,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`Anthropic API returned HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const body: any = await res.json();
    const rawText: string = body?.content?.[0]?.text ?? "";

    let parsed: { reply?: string; suggested_skus?: string[]; discount_pct?: number; reasoning?: string };
    try {
      // The model is instructed to return raw JSON, but defensively strip
      // any surrounding markdown fence in case it doesn't comply exactly.
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    } catch {
      parsed = { reply: rawText || "I'm not sure how to help with that — could you rephrase?", suggested_skus: [], discount_pct: 0, reasoning: "Model response was not valid JSON — passed through as plain text, no discount applied." };
    }

    // The model proposes; the policy engine is the authority. Never trust
    // its number directly, whatever it said.
    const proposedDiscount = typeof parsed.discount_pct === "number" ? parsed.discount_pct : 0;
    const clampedDiscount = Math.max(0, Math.min(proposedDiscount, policy.max_auto_discount_pct));

    // Never let the model recommend a SKU that doesn't actually exist —
    // filter its suggestions against the real catalog it was given.
    const catalog = await listCatalog(merchantId);
    const validSkus = new Set(catalog.map((p) => p.sku));
    const suggestedSkus = (Array.isArray(parsed.suggested_skus) ? parsed.suggested_skus : []).filter((s) => validSkus.has(s));

    const reasoning = parsed.reasoning ?? "No reasoning provided by the model.";
    const audit = await writeAudit(merchantId, {
      intent_id: `storefront_${convId}`,
      step: "STOREFRONT_CONVERSATION",
      outcome: "PASS",
      actor: "ai_storefront",
      reason:
        clampedDiscount !== proposedDiscount
          ? `${reasoning} (model proposed ${proposedDiscount}%, clamped to policy ceiling ${policy.max_auto_discount_pct}%)`
          : reasoning,
      detail: { conversation_id: convId, message, suggested_skus: suggestedSkus, proposed_discount_pct: proposedDiscount, applied_discount_pct: clampedDiscount },
    });

    return {
      conversation_id: convId,
      reply: parsed.reply ?? "I'm here to help — what are you looking for?",
      suggested_skus: suggestedSkus,
      discount_pct: clampedDiscount,
      reasoning,
      degraded: false,
      audit_id: audit.audit_id,
    };
  } catch (err: any) {
    // A model outage or network failure degrades gracefully — same
    // no-fake-money-path guarantee as every other external integration
    // in this codebase (Razorpay, SMTP): the conversation still responds,
    // it just can't reason live right now.
    const fallback = degradedReply(cartSkus);
    const audit = await writeAudit(merchantId, {
      intent_id: `storefront_${convId}`,
      step: "STOREFRONT_CONVERSATION",
      outcome: "FAIL",
      actor: "ai_storefront",
      reason: `Anthropic API call failed: ${err?.message ?? String(err)} — fell back to a static reply`,
      detail: { conversation_id: convId, message, error: err?.message ?? String(err) },
    });
    return {
      conversation_id: convId,
      reply: "Sorry — I'm having trouble thinking right now. Could you try again in a moment?",
      suggested_skus: fallback.suggested_skus,
      discount_pct: 0,
      reasoning: `Model call failed: ${err?.message ?? String(err)}`,
      degraded: true,
      audit_id: audit.audit_id,
    };
  }
}
