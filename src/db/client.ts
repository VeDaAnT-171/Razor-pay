/**
 * src/db/client.ts
 *
 * Single Postgres connection pool + Drizzle instance for the whole process.
 * Every repository module in src/db/ imports `db` from here — nothing
 * outside src/db/ should import `pg` or `drizzle-orm` directly.
 */

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and point it at a running Postgres instance " +
      "(docker-compose up -d postgres gives you one locally)."
  );
}

export const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });

export async function assertDbReachable(): Promise<void> {
  await pool.query("SELECT 1");
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
