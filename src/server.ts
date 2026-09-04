/**
 * src/server.ts
 *
 * Razorpay Agentic Commerce OS (A-COS) — Fastify entry point, multi-tenant.
 *
 * Two separate credential types gate every route:
 *   - Agent API key (`x-api-key`) — what an external AI buyer agent
 *     presents on every catalog/checkout/negotiation call. See
 *     middleware/auth.ts#requireAgentAuth.
 *   - Dashboard session (JWT `Authorization: Bearer`) — what the merchant's
 *     own logged-in dashboard uses for everything else (policy, campaigns,
 *     approvals, audit trail, the growth dashboard...). See
 *     middleware/auth.ts#requireDashboardAuth.
 * Nothing downstream ever runs without one of these resolving to a real
 * `merchantId` — there is no un-scoped code path.
 *
 * Wires together:
 *   - Auth: signup/login/rotate-key (/auth/*)
 *   - Module 1: agent-readable catalog  (/agent/v1/catalog/*)
 *   - Module 2: conversational checkout / protocol bridge (/agent/v1/checkout)
 *   - Module 3: upsell/cross-sell + negotiation (/agent/v1/cart/*, /agent/v1/negotiate)
 *   - Module 4: audit engine + guardrail gate (/agent/v1/audit/*, failure simulation)
 *   - Checkout sessions, approvals, refunds, payment links, webhooks, policy v2,
 *     agent profiles, campaigns, the growth engine, and the Test Lab.
 *
 * Run: npm run dev   (after `npm install`, `docker compose up -d postgres`,
 * `npm run db:push`, and configuring .env)
 */

import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";

import { requireAgentAuth, requireDashboardAuth } from "./middleware/auth";
import * as authService from "./services/auth";
import {
  buildJsonLdCatalog,
  buildOpenApiSpec,
  checkInventory,
  getProductDetail,
  getProductQuote,
  searchCatalog,
} from "./services/mcp_catalog";
import { getStoreProfileWithReadiness } from "./services/store_profile";
import { createCampaign, activateCampaign, pauseCampaign, listCampaigns, getCampaign } from "./services/campaigns";
import { bridgeCheckout } from "./services/protocol_bridge";
import { evaluateNegotiation } from "./services/negotiation";
import { getRecommendations, getOpportunities, recordImpressions, toggleRecommendation } from "./services/growth";
import { registerGuardrailRoutes } from "./middleware/guardrail_gate";
import { getAuditTrail, getFullAuditLog, verifyChain } from "./services/audit_log";
import { CheckoutCreateRequest, NegotiationOffer, RefundRequest, PaymentLinkRequest, ApprovalAction } from "./schema/types";
import { getSession, listSessions } from "./services/checkout_session";
import { listApprovals, resolveApproval } from "./services/approvals";
import { processRefund, listRefunds } from "./services/refunds";
import { createPaymentLink, listPaymentLinks } from "./services/payment_links";
import { processWebhook, listWebhookEvents } from "./services/webhooks";
import { getPublishedPolicy, getDraftPolicy, saveDraft, publishDraft, getPolicyHistory, getAgentProfile } from "./services/policy_store";
import { runTestSuite } from "./services/test_lab";
import { simulateTestPayment } from "./services/dev_tools";
import { assertDbReachable } from "./db/client";

const app = Fastify({ logger: true, trustProxy: true });

async function main() {
  await assertDbReachable().catch((err) => {
    app.log.error({ err }, "Cannot reach Postgres at startup — check DATABASE_URL and that the database is running.");
    throw err;
  });

  const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean);
  await app.register(cors, { origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false }); // CSP off: this is an API service, not a page host
  await app.register(cookie);
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: "1 minute",
  });

  // Webhooks need the RAW body for HMAC verification — capture it before
  // Fastify's default JSON parser runs, for this route's content-type only.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      (_req as any).rawBody = body as string;
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err: any) {
      done(err, undefined);
    }
  });

  /* -------------------------------------------------------------- */
  /* Health (public)                                                  */
  /* -------------------------------------------------------------- */
  app.get("/health", async () => ({ status: "ok", service: "razorpay-a-cos", time: new Date().toISOString() }));

  /* -------------------------------------------------------------- */
  /* Auth — merchant signup/login, session + API key issuance          */
  /* -------------------------------------------------------------- */
  app.post<{ Body: { name: string; email: string; password: string } }>(
    "/auth/signup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { name, email, password } = request.body ?? ({} as any);
      const result = await authService.signup(name, email, password);
      if (!result.ok) return reply.status(result.httpStatus).send({ error: result.error });
      return reply.status(201).send({
        status: "OK",
        merchant: result.merchant,
        token: result.token,
        api_key: result.api_key, // shown ONCE — the merchant must save it now
      });
    }
  );

  app.post<{ Body: { email: string; password: string } }>(
    "/auth/login",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { email, password } = request.body ?? ({} as any);
      const result = await authService.login(email, password);
      if (!result.ok) return reply.status(result.httpStatus).send({ error: result.error });
      return { status: "OK", merchant: result.merchant, token: result.token };
    }
  );

  app.get("/auth/me", { preHandler: requireDashboardAuth }, async (request) => {
    return { merchant: request.merchant };
  });

  app.post("/auth/rotate-key", { preHandler: requireDashboardAuth }, async (request, reply) => {
    const result = await authService.rotateApiKey(request.merchantId!);
    if (!result) return reply.status(404).send({ error: "Merchant not found" });
    return { status: "OK", api_key: result.api_key, api_key_prefix: result.api_key_prefix };
  });

  /* -------------------------------------------------------------- */
  /* Merchant Commerce Profile + AI Transactability Score (dashboard) */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/store", { preHandler: requireDashboardAuth }, async (request) =>
    getStoreProfileWithReadiness(request.merchantId!)
  );

  /* -------------------------------------------------------------- */
  /* Module 1 — Agent-readable catalog (agent-authenticated)         */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/catalog", { preHandler: requireAgentAuth }, async (request) =>
    buildJsonLdCatalog(request.merchantId!, request.merchant!.name)
  );

  app.get<{ Params: { sku: string } }>(
    "/agent/v1/catalog/product/:sku",
    { preHandler: requireAgentAuth },
    async (request, reply) => {
      const result = await getProductDetail(request.merchantId!, request.params.sku);
      if ("error" in result) return reply.status(404).send(result);
      return result;
    }
  );

  // Public discovery document — no merchant data, just the API shape.
  app.get("/agent/v1/catalog/openapi.json", async (request) => {
    const proto = (request.headers["x-forwarded-proto"] as string) ?? "http";
    const baseUrl = `${proto}://${request.headers.host}`;
    return buildOpenApiSpec(baseUrl);
  });

  app.get<{ Querystring: { query?: string; category?: string; max_price_inr?: string } }>(
    "/agent/v1/catalog/search",
    { preHandler: requireAgentAuth },
    async (request) => {
      const { query, category, max_price_inr } = request.query;
      return searchCatalog(request.merchantId!, {
        query,
        category,
        max_price_inr: max_price_inr ? Number(max_price_inr) : undefined,
      });
    }
  );

  app.get<{ Params: { sku: string } }>(
    "/agent/v1/catalog/quote/:sku",
    { preHandler: requireAgentAuth },
    async (request, reply) => {
      const result = await getProductQuote(request.merchantId!, request.params.sku);
      if ("error" in result) return reply.status(404).send(result);
      return result;
    }
  );

  app.get<{ Params: { sku: string }; Querystring: { qty?: string } }>(
    "/agent/v1/catalog/inventory/:sku",
    { preHandler: requireAgentAuth },
    async (request, reply) => {
      const qty = request.query.qty ? Number(request.query.qty) : 1;
      const result = await checkInventory(request.merchantId!, request.params.sku, qty);
      if ("error" in result) return reply.status(404).send(result);
      return result;
    }
  );

  /* -------------------------------------------------------------- */
  /* Module 2 — Conversational checkout / protocol bridge (agent)    */
  /* -------------------------------------------------------------- */
  app.post("/agent/v1/checkout", { preHandler: requireAgentAuth }, async (request, reply) => {
    const parsed = CheckoutCreateRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "VALIDATION_ERROR", issues: parsed.error.issues });
    }

    const merchantId = request.merchantId!;
    const idempotencyKey = (request.headers["idempotency-key"] as string) || undefined;
    const result = await bridgeCheckout(merchantId, parsed.data, idempotencyKey);

    switch (result.status) {
      case "ORDER_CREATED":
        // Order creation is NOT the same as a captured payment — the UI
        // must never read this as "paid". See CheckoutSession.payment_status.
        return reply.status(201).send({
          status: "ORDER_CREATED",
          intent_id: result.intent.intent_id,
          checkout_session_id: result.session.checkout_session_id,
          checkout_session: result.session,
          razorpay_order: result.razorpay_order,
          audit_id: result.audit_id,
          audit_trail: await getAuditTrail(merchantId, result.intent.intent_id),
          idempotency_key: idempotencyKey ?? null,
        });
      case "PENDING_HUMAN_APPROVAL":
        return reply.status(202).send({
          status: "PENDING_HUMAN_APPROVAL",
          intent_id: result.intent.intent_id,
          checkout_session_id: result.session.checkout_session_id,
          checkout_session: result.session,
          approval_id: result.approval_id,
          reason: result.reason,
          audit_id: result.audit_id,
          audit_trail: await getAuditTrail(merchantId, result.intent.intent_id),
        });
      case "REJECTED":
        return reply.status(result.httpStatus).send({
          status: "REJECTED",
          reason: result.reason,
          checkout_session_id: result.session?.checkout_session_id,
          audit_id: result.audit_id,
        });
    }
  });

  // ACP-native alias, matching the ACP spec's literal route name. Forwards
  // the caller's API key through so the injected request authenticates
  // exactly like a direct call would.
  app.post("/checkout/create", async (request, reply) => {
    const apiKey = request.headers["x-api-key"];
    return app.inject({
      method: "POST",
      url: "/agent/v1/checkout",
      payload: request.body as any,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey as string } : {}),
      },
    }).then((res) => reply.status(res.statusCode).send(res.json()));
  });

  /* -------------------------------------------------------------- */
  /* Checkout sessions — the canonical, server-authoritative record  */
  /* (dashboard)                                                      */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/sessions", { preHandler: requireDashboardAuth }, async (request) => ({
    sessions: await listSessions(request.merchantId!),
  }));

  app.get<{ Params: { id: string } }>(
    "/agent/v1/sessions/:id",
    { preHandler: requireDashboardAuth },
    async (request, reply) => {
      const session = await getSession(request.merchantId!, request.params.id);
      if (!session) return reply.status(404).send({ error: "Unknown checkout_session_id" });
      return { session, audit_trail: await getAuditTrail(request.merchantId!, session.intent_id) };
    }
  );

  /* -------------------------------------------------------------- */
  /* Module 3 — Upsell/cross-sell + negotiation (agent)               */
  /* -------------------------------------------------------------- */
  app.post<{ Body: { cart_skus: string[] } }>(
    "/agent/v1/cart/recommendations",
    { preHandler: requireAgentAuth },
    async (request, reply) => {
      const skus = request.body?.cart_skus;
      if (!Array.isArray(skus) || skus.length === 0) {
        return reply.status(400).send({ error: "cart_skus must be a non-empty array of SKU strings" });
      }
      const merchantId = request.merchantId!;
      const recommendations = await getRecommendations(merchantId, skus);
      await recordImpressions(merchantId, skus);
      return { cart_skus: skus, recommendations };
    }
  );

  app.post("/agent/v1/negotiate", { preHandler: requireAgentAuth }, async (request, reply) => {
    const parsed = NegotiationOffer.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "VALIDATION_ERROR", issues: parsed.error.issues });
    }
    return evaluateNegotiation(request.merchantId!, parsed.data);
  });

  /* -------------------------------------------------------------- */
  /* Growth — Upsell & Cross-sell Agent + Revenue Opportunities       */
  /* (spec sections 21/23, Phase 7) — real acceptance-rate model,     */
  /* baseline-blended until enough live samples exist. Dashboard.     */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/growth/recommendations", { preHandler: requireDashboardAuth }, async (request) => ({
    recommendations: await getRecommendations(request.merchantId!),
  }));

  app.get("/agent/v1/growth/opportunities", { preHandler: requireDashboardAuth }, async (request) => ({
    opportunities: await getOpportunities(request.merchantId!),
  }));

  app.post<{ Body: { primary_sku: string; companion_sku: string; enabled: boolean } }>(
    "/agent/v1/growth/recommendations/toggle",
    { preHandler: requireDashboardAuth },
    async (request, reply) => {
      const { primary_sku, companion_sku, enabled } = request.body ?? ({} as any);
      if (!primary_sku || !companion_sku || typeof enabled !== "boolean") {
        return reply.status(400).send({ error: "primary_sku, companion_sku and enabled are required" });
      }
      await toggleRecommendation(request.merchantId!, primary_sku, companion_sku, enabled);
      return { status: "OK", primary_sku, companion_sku, enabled };
    }
  );

  /* -------------------------------------------------------------- */
  /* Approvals — real approve/reject/modify semantics (dashboard)    */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/approvals", { preHandler: requireDashboardAuth }, async (request) => ({
    approvals: await listApprovals(request.merchantId!),
  }));

  app.post("/agent/v1/approvals/resolve", { preHandler: requireDashboardAuth }, async (request, reply) => {
    const parsed = ApprovalAction.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "VALIDATION_ERROR", issues: parsed.error.issues });
    const { approval_id, action, modified_limit_inr, note } = parsed.data;
    const result = await resolveApproval(request.merchantId!, approval_id, action, modified_limit_inr, note);
    if (!result.ok) return reply.status(result.httpStatus).send({ error: result.error });
    return { status: "OK", approval: result.approval };
  });

  /* -------------------------------------------------------------- */
  /* Refunds — real Razorpay Refunds API (dashboard)                  */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/refunds", { preHandler: requireDashboardAuth }, async (request) => ({
    refunds: await listRefunds(request.merchantId!),
  }));

  app.post("/agent/v1/refunds", { preHandler: requireDashboardAuth }, async (request, reply) => {
    const parsed = RefundRequest.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "VALIDATION_ERROR", issues: parsed.error.issues });
    const idempotencyKey = (request.headers["idempotency-key"] as string) || parsed.data.idempotency_key;
    const result = await processRefund(request.merchantId!, parsed.data.checkout_session_id, parsed.data.amount_inr, parsed.data.reason, idempotencyKey);
    if (!result.ok) return reply.status(result.httpStatus).send({ error: result.error });
    return reply.status(201).send({ status: "OK", refund: result.refund });
  });

  /* -------------------------------------------------------------- */
  /* Payment Links — real Razorpay Payment Links API (dashboard)     */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/payment-links", { preHandler: requireDashboardAuth }, async (request) => ({
    payment_links: await listPaymentLinks(request.merchantId!),
  }));

  app.post("/agent/v1/payment-links", { preHandler: requireDashboardAuth }, async (request, reply) => {
    const parsed = PaymentLinkRequest.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "VALIDATION_ERROR", issues: parsed.error.issues });
    const result = await createPaymentLink(request.merchantId!, parsed.data);
    if (!result.ok) return reply.status(result.httpStatus).send({ error: result.error });
    return reply.status(201).send({ status: "OK", payment_link: result.link });
  });

  /* -------------------------------------------------------------- */
  /* Webhooks — real HMAC signature verification                     */
  /* Inbound event: PUBLIC (Razorpay itself calls this; the HMAC IS   */
  /* the authentication). Event list: dashboard.                     */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/webhooks/events", { preHandler: requireDashboardAuth }, async (request) => ({
    events: await listWebhookEvents(request.merchantId!),
  }));

  app.post("/agent/v1/webhooks/razorpay", async (request, reply) => {
    const rawBody = (request as any).rawBody ?? JSON.stringify(request.body ?? {});
    const signature = request.headers["x-razorpay-signature"] as string | undefined;
    const eventId = request.headers["x-razorpay-event-id"] as string | undefined;
    const result = await processWebhook(rawBody, signature, eventId);
    return reply.status(result.httpStatus).send(result.body);
  });

  /* -------------------------------------------------------------- */
  /* Policy v2 — versioned, draft/publish (dashboard)                 */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/policy", { preHandler: requireDashboardAuth }, async (request) => {
    const merchantId = request.merchantId!;
    const [published, draft, history] = await Promise.all([
      getPublishedPolicy(merchantId),
      getDraftPolicy(merchantId),
      getPolicyHistory(merchantId),
    ]);
    return { published, draft, history };
  });

  app.post("/agent/v1/policy/draft", { preHandler: requireDashboardAuth }, async (request) => {
    return { draft: await saveDraft(request.merchantId!, (request.body as any) ?? {}) };
  });

  app.post("/agent/v1/policy/publish", { preHandler: requireDashboardAuth }, async (request) => {
    return { published: await publishDraft(request.merchantId!) };
  });

  app.get<{ Params: { agentId: string } }>(
    "/agent/v1/agents/:agentId",
    { preHandler: requireDashboardAuth },
    async (request) => {
      return { agent: await getAgentProfile(request.merchantId!, request.params.agentId) };
    }
  );

  /* -------------------------------------------------------------- */
  /* Campaigns — real store, discount validated against Policy v2    */
  /* (dashboard)                                                      */
  /* -------------------------------------------------------------- */
  app.get("/agent/v1/campaigns", { preHandler: requireDashboardAuth }, async (request) => ({
    campaigns: await listCampaigns(request.merchantId!),
  }));

  app.post("/agent/v1/campaigns", { preHandler: requireDashboardAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const result = await createCampaign(request.merchantId!, {
      name: body.name,
      trigger_intent: body.trigger_intent ?? "",
      product_skus: body.product_skus ?? [],
      discount_inr: Number(body.discount_inr),
      budget_inr: Number(body.budget_inr),
      daily_order_limit: body.daily_order_limit ? Number(body.daily_order_limit) : undefined,
    });
    if (!result.ok) return reply.status(result.httpStatus).send({ error: result.error });
    return reply.status(201).send({ status: "OK", campaign: result.campaign });
  });

  app.post<{ Params: { id: string } }>(
    "/agent/v1/campaigns/:id/activate",
    { preHandler: requireDashboardAuth },
    async (request, reply) => {
      const result = await activateCampaign(request.merchantId!, request.params.id);
      if (!result.ok) return reply.status(result.httpStatus).send({ error: result.error });
      return { status: "OK", campaign: result.campaign };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/agent/v1/campaigns/:id/pause",
    { preHandler: requireDashboardAuth },
    async (request, reply) => {
      const result = await pauseCampaign(request.merchantId!, request.params.id);
      if (!result.ok) return reply.status(result.httpStatus).send({ error: result.error });
      return { status: "OK", campaign: result.campaign };
    }
  );

  app.get<{ Params: { id: string } }>(
    "/agent/v1/campaigns/:id",
    { preHandler: requireDashboardAuth },
    async (request, reply) => {
      const c = await getCampaign(request.merchantId!, request.params.id);
      if (!c) return reply.status(404).send({ error: "Unknown campaign_id" });
      return { campaign: c };
    }
  );

  /* -------------------------------------------------------------- */
  /* Module 4 — Audit engine + guardrail gate                        */
  /* simulate-failure is agent-authenticated (registered in           */
  /* guardrail_gate.ts); trail/log/verify are dashboard.               */
  /* -------------------------------------------------------------- */
  registerGuardrailRoutes(app);

  app.get<{ Params: { intentId: string } }>(
    "/agent/v1/audit/:intentId",
    { preHandler: requireDashboardAuth },
    async (request) => {
      return { intent_id: request.params.intentId, trail: await getAuditTrail(request.merchantId!, request.params.intentId) };
    }
  );

  app.get("/agent/v1/audit", { preHandler: requireDashboardAuth }, async (request) => ({
    entries: await getFullAuditLog(request.merchantId!),
  }));

  app.get("/agent/v1/audit/verify-chain", { preHandler: requireDashboardAuth }, async (request) =>
    verifyChain(request.merchantId!)
  );

  /* -------------------------------------------------------------- */
  /* Test Lab — real scripted scenarios, real pass/fail (dashboard)   */
  /* Runs against the calling merchant's own tenant.                  */
  /* -------------------------------------------------------------- */
  app.post("/agent/v1/test-lab/run", { preHandler: requireDashboardAuth }, async (request) =>
    runTestSuite(request.merchantId!)
  );

  /* -------------------------------------------------------------- */
  /* Dev tool: SIMULATED payment completion (sandbox has no public   */
  /* URL for a real Razorpay webhook — see dev_tools.ts header).     */
  /* Dashboard-only — this is an operator action, never agent-facing. */
  /* -------------------------------------------------------------- */
  app.post<{ Body: { checkout_session_id: string; outcome?: "capture" | "fail" } }>(
    "/agent/v1/dev/simulate-payment",
    { preHandler: requireDashboardAuth },
    async (request, reply) => {
      const { checkout_session_id, outcome } = request.body ?? ({} as any);
      if (!checkout_session_id) return reply.status(400).send({ error: "checkout_session_id is required" });
      const result = await simulateTestPayment(request.merchantId!, checkout_session_id, outcome ?? "capture");
      if (!result.ok) return reply.status(result.httpStatus).send({ error: result.error });
      return { status: "OK", simulated: true, session: result.session };
    }
  );

  /* -------------------------------------------------------------- */
  /* Error handling                                                   */
  /* -------------------------------------------------------------- */
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "VALIDATION_ERROR", issues: err.issues });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "INTERNAL_ERROR", message: err.message });
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
