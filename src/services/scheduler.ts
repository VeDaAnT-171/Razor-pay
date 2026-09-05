/**
 * src/services/scheduler.ts
 *
 * The "expired payment link / abandoned checkout" half of the failure-
 * handling bar: a background sweep, running in-process (this is a
 * single long-lived Node service — no external cron infra to deploy),
 * that periodically:
 *
 *   1. Releases every inventory hold whose lock timestamp has passed
 *      (services/inventory.ts#releaseAllExpiredHolds) — stock goes back
 *      to the pool the moment a checkout's payment window runs out,
 *      not whenever someone next happens to look.
 *   2. Finds every checkout session past its own `expires_at` that's
 *      still sitting in a non-terminal, unpaid state and transitions it
 *      to TIMEOUT, with an audit entry explaining why — so the session
 *      record itself reflects reality, not just the hold.
 *
 * Both steps are cross-tenant scans (see the documented exceptions in
 * db/sessions.ts and db/inventory_holds.ts) since a background sweep has
 * no single merchant's request context to scope by.
 */

import { findExpiredActiveSessions } from "../db/sessions";
import { transitionSession } from "./checkout_session";
import { releaseAllExpiredHolds } from "./inventory";
import { writeAudit } from "./audit_log";

const SWEEP_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_SEC ?? 60) * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

async function sweepOnce(): Promise<void> {
  // 1. Release any inventory hold whose lock timestamp has passed.
  try {
    await releaseAllExpiredHolds();
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error("[scheduler] inventory hold sweep failed:", err?.message ?? err);
  }

  // 2. Time out any checkout session whose payment window has closed
  // without a completed payment. Each session is scoped by its own
  // merchantId for the transition itself, even though the *lookup* that
  // found it was cross-tenant.
  try {
    const expiredSessions = await findExpiredActiveSessions(new Date());
    for (const session of expiredSessions) {
      try {
        await transitionSession(
          session.merchantId,
          session.id,
          "TIMEOUT",
          "scheduler",
          `Payment window closed at ${session.expiresAt?.toISOString()} with no completed payment — session timed out`
        );
        await writeAudit(session.merchantId, {
          intent_id: session.intentId,
          step: "FAILURE",
          outcome: "FAIL",
          actor: "scheduler",
          reason: `Checkout session ${session.id} timed out — payment window closed without a captured payment. Any held inventory has been released back to stock.`,
          detail: { checkout_session_id: session.id },
        });
      } catch (err: any) {
        // One session's illegal-transition edge case (e.g. a webhook
        // landed in the same instant) must never stop the rest of the
        // sweep from running.
        // eslint-disable-next-line no-console
        console.error(`[scheduler] failed to time out session ${session.id}:`, err?.message ?? err);
      }
    }
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error("[scheduler] session expiry sweep failed:", err?.message ?? err);
  }
}

/** Starts the background sweep. Idempotent — calling it twice does not start a second timer. */
export function startBackgroundJobs(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepOnce();
  }, SWEEP_INTERVAL_MS);
  // Fastify's server keeps the process alive anyway, but .unref() means
  // this timer alone would never block a graceful shutdown/test run.
  timer.unref?.();
}

export function stopBackgroundJobs(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposed for the Test Lab / a manual "run the sweep now" dev route, so the failure-handling path can be demoed without waiting for a real timeout. */
export const runSweepNow = sweepOnce;
