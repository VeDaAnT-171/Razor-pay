/**
 * src/services/outbound_webhooks.ts
 *
 * Real outbound event notifications: when something happens on a
 * merchant's tenant (an order is created, a checkout is blocked by
 * policy, a human approval is requested, or the audit hash-chain is
 * found broken on verification), every one of that merchant's enabled
 * endpoints subscribed to that event gets an HTTP POST — signed with
 * HMAC-SHA256 over the raw JSON body, the same pattern this codebase
 * already uses for inbound Razorpay webhooks (see services/webhooks.ts),
 * just in the other direction.
 *
 * Delivery is fire-and-forget from the caller's perspective (checkout/
 * approval/audit code paths never block on, or fail because of, a slow
 * or unreachable merchant server) but every attempt — success or
 * failure — is logged to outbound_webhook_deliveries so the dashboard
 * can show the merchant real delivery history, not a black box.
 *
 * No retry queue in this build: one attempt, a 5s timeout, logged
 * outcome. A production hardening pass would add exponential-backoff
 * retries — see README "Known limitations".
 */

import { randomBytes, createHmac } from "crypto";
import * as repo from "../db/outbound_webhooks";

export const OUTBOUND_EVENTS = ["order.created", "order.blocked", "approval.requested", "audit.chain_broken"] as const;
export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

export interface OutboundEndpoint {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret_prefix: string;
  created_at: string;
}

export interface OutboundDelivery {
  id: string;
  endpoint_id: string;
  event: string;
  url: string;
  success: boolean;
  status_code: number | null;
  error: string | null;
  payload_summary: Record<string, unknown>;
  created_at: string;
}

function generateSecret(): { raw: string; prefix: string } {
  const raw = `whsec_${randomBytes(24).toString("hex")}`;
  return { raw, prefix: raw.slice(0, 12) };
}

function toPublicEndpoint(row: repo.OutboundEndpointRow): OutboundEndpoint {
  return {
    id: row.id,
    url: row.url,
    events: Array.isArray(row.events) ? (row.events as string[]) : [],
    enabled: row.enabled,
    secret_prefix: row.secretPrefix,
    created_at: row.createdAt.toISOString(),
  };
}

function toPublicDelivery(row: repo.OutboundDeliveryRow): OutboundDelivery {
  return {
    id: row.id,
    endpoint_id: row.endpointId,
    event: row.event,
    url: row.url,
    success: row.success,
    status_code: row.statusCode,
    error: row.error,
    payload_summary: (row.payloadSummary as Record<string, unknown>) ?? {},
    created_at: row.createdAt.toISOString(),
  };
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Registers a new outbound endpoint for this merchant. The raw secret is returned ONCE, exactly like the agent API key. */
export async function registerEndpoint(
  merchantId: string,
  url: string,
  events?: string[]
): Promise<{ ok: true; endpoint: OutboundEndpoint; secret: string } | { ok: false; error: string }> {
  if (!url || !isValidUrl(url)) return { ok: false, error: "A valid http(s) URL is required" };
  const chosenEvents = events && events.length > 0 ? events.filter((e) => (OUTBOUND_EVENTS as readonly string[]).includes(e)) : [...OUTBOUND_EVENTS];
  if (chosenEvents.length === 0) return { ok: false, error: "No valid events selected" };

  const { raw, prefix } = generateSecret();
  const row = await repo.insertEndpoint({ merchantId, url, secret: raw, secretPrefix: prefix, events: chosenEvents });
  return { ok: true, endpoint: toPublicEndpoint(row), secret: raw };
}

export async function listEndpoints(merchantId: string): Promise<OutboundEndpoint[]> {
  const rows = await repo.listEndpointsForMerchant(merchantId);
  return rows.map(toPublicEndpoint);
}

export async function deleteEndpoint(merchantId: string, id: string): Promise<boolean> {
  return repo.deleteEndpoint(merchantId, id);
}

export async function listRecentDeliveries(merchantId: string, limit = 20): Promise<OutboundDelivery[]> {
  const rows = await repo.listRecentDeliveries(merchantId, limit);
  return rows.map(toPublicDelivery);
}

export type TestEventResult =
  | { ok: true; success: boolean; status_code: number | null; error: string | null }
  | { ok: false; error: string };

/** Fires one synthetic `webhook.test` delivery at a single endpoint, on demand — for the dashboard's "Send test event" button. Logged to the same delivery history as real events. */
export async function sendTestEvent(merchantId: string, endpointId: string): Promise<TestEventResult> {
  const endpoints = await repo.listEndpointsForMerchant(merchantId);
  const ep = endpoints.find((e) => e.id === endpointId);
  if (!ep) return { ok: false, error: "Endpoint not found" };

  const body = JSON.stringify({
    event: "webhook.test",
    created_at: new Date().toISOString(),
    merchant_id: merchantId,
    data: { message: "This is a test event from A-COS. If you can read this and the signature verifies, your endpoint is wired up correctly." },
  });
  const signature = createHmac("sha256", ep.secret).update(body).digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acos-event": "webhook.test", "x-acos-signature": signature },
      body,
      signal: controller.signal,
    });
    await repo.insertDelivery({
      merchantId, endpointId: ep.id, event: "webhook.test", url: ep.url,
      success: res.ok, statusCode: res.status, error: res.ok ? null : `HTTP ${res.status}`, payloadSummary: { test: true },
    });
    return { ok: true, success: res.ok, status_code: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err: any) {
    const msg = err?.name === "AbortError" ? "Timed out after 5s" : (err?.message ?? String(err));
    await repo.insertDelivery({
      merchantId, endpointId: ep.id, event: "webhook.test", url: ep.url,
      success: false, statusCode: null, error: msg, payloadSummary: { test: true },
    });
    return { ok: true, success: false, status_code: null, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fires `event` to every enabled endpoint this merchant has subscribed to
 * it. Never throws — a delivery failure is logged, not propagated, so a
 * merchant's misconfigured or offline receiving server can never break
 * A-COS's own checkout/approval/audit flow.
 */
export async function dispatchEvent(merchantId: string, event: OutboundEvent, data: Record<string, unknown>): Promise<void> {
  let endpoints: repo.OutboundEndpointRow[];
  try {
    endpoints = await repo.listEnabledEndpointsForEvent(merchantId, event);
  } catch {
    return; // best-effort — never let a lookup failure ripple into the caller
  }
  if (endpoints.length === 0) return;

  const body = JSON.stringify({ event, created_at: new Date().toISOString(), merchant_id: merchantId, data });

  await Promise.all(
    endpoints.map(async (ep) => {
      // Signed with the exact secret shown to the merchant once at
      // registration — they verify on their end with
      // HMAC-SHA256(secret, raw_request_body), same pattern this codebase
      // uses for verifying INBOUND Razorpay webhooks (services/webhooks.ts).
      const signature = createHmac("sha256", ep.secret).update(body).digest("hex");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(ep.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-acos-event": event,
            "x-acos-signature": signature,
          },
          body,
          signal: controller.signal,
        });
        await repo.insertDelivery({
          merchantId,
          endpointId: ep.id,
          event,
          url: ep.url,
          success: res.ok,
          statusCode: res.status,
          error: res.ok ? null : `HTTP ${res.status}`,
          payloadSummary: data,
        });
      } catch (err: any) {
        await repo.insertDelivery({
          merchantId,
          endpointId: ep.id,
          event,
          url: ep.url,
          success: false,
          statusCode: null,
          error: err?.name === "AbortError" ? "Timed out after 5s" : (err?.message ?? String(err)),
          payloadSummary: data,
        });
      } finally {
        clearTimeout(timeout);
      }
    })
  );
}
