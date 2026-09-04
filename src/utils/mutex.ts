/**
 * src/utils/mutex.ts
 *
 * A tiny per-key async mutex. Used to serialize the hash-chain audit
 * writer per merchant within this process — Postgres alone can't stop two
 * concurrent requests from both reading the same "last hash" and racing
 * to append next, which would silently fork the chain. This closes that
 * race for a single running instance.
 *
 * It does NOT close it across multiple horizontally-scaled instances of
 * this service sharing one database — that needs a real distributed lock
 * (e.g. Postgres advisory locks via `pg_advisory_xact_lock`) and is out of
 * scope for this pass; see README "Known limitations". Run one instance
 * per deployment, or add that lock before scaling out.
 */

const tails = new Map<string, Promise<unknown>>();

export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run fn once prev settles, regardless of prev's outcome
  tails.set(key, run.catch(() => undefined)); // keep the chain alive even if this run rejects
  return run;
}
