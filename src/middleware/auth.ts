/**
 * src/middleware/auth.ts
 *
 * Two Fastify preHandlers, matching the two credential types in
 * services/auth.ts:
 *
 *  - requireAgentAuth: every `/agent/v1/*` route an AI buyer agent calls.
 *    Reads `x-api-key`, resolves it to a merchant, sets
 *    `request.merchantId` / `request.merchant`. 401s with no state change
 *    on a missing/invalid key — nothing downstream ever runs un-scoped.
 *
 *  - requireDashboardAuth: every merchant-dashboard route (policy edits,
 *    campaigns, approvals, the growth dashboard, audit trail, etc). Reads
 *    a Bearer JWT from `Authorization`, verifies it, sets the same two
 *    request fields. Also accepts the `acos_session` cookie as a fallback
 *    so a browser tab can stay signed in without hand-managing headers.
 *
 * Both attach the SAME `request.merchantId` shape so every downstream
 * service call looks identical regardless of which credential the caller
 * used — the service layer never needs to know which door the request
 * came through.
 */

import { FastifyReply, FastifyRequest } from "fastify";
import { resolveMerchantByApiKey, verifySessionToken, getMerchant, PublicMerchant } from "../services/auth";

declare module "fastify" {
  interface FastifyRequest {
    merchantId?: string;
    merchant?: PublicMerchant;
  }
}

export async function requireAgentAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = request.headers["x-api-key"];
  const raw = Array.isArray(key) ? key[0] : key;
  if (!raw) {
    reply.status(401).send({ error: "UNAUTHORIZED", message: "Missing x-api-key header. Agent requests must present a merchant API key." });
    return reply as any;
  }
  const merchant = await resolveMerchantByApiKey(raw);
  if (!merchant) {
    reply.status(401).send({ error: "UNAUTHORIZED", message: "Invalid API key." });
    return reply as any;
  }
  request.merchantId = merchant.merchant_id;
  request.merchant = merchant;
}

function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const cookieToken = (request as any).cookies?.acos_session;
  if (cookieToken) return cookieToken;
  return undefined;
}

export async function requireDashboardAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractBearer(request);
  if (!token) {
    reply.status(401).send({ error: "UNAUTHORIZED", message: "Missing session. Log in and send the token as a Bearer header." });
    return reply as any;
  }
  const decoded = verifySessionToken(token);
  if (!decoded) {
    reply.status(401).send({ error: "UNAUTHORIZED", message: "Session expired or invalid — log in again." });
    return reply as any;
  }
  const merchant = await getMerchant(decoded.merchant_id);
  if (!merchant) {
    reply.status(401).send({ error: "UNAUTHORIZED", message: "Account no longer exists." });
    return reply as any;
  }
  request.merchantId = merchant.merchant_id;
  request.merchant = merchant;
}
