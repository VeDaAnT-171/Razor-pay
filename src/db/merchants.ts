/**
 * src/db/merchants.ts — repository layer for the `merchants` table.
 */

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "./client";
import { merchants } from "./schema";

export interface MerchantRow {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
  plan: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function insertMerchant(input: {
  name: string;
  email: string;
  passwordHash: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
}): Promise<MerchantRow> {
  const id = `mer_${randomUUID()}`;
  const [row] = await db
    .insert(merchants)
    .values({
      id,
      name: input.name,
      email: input.email.toLowerCase().trim(),
      passwordHash: input.passwordHash,
      apiKeyHash: input.apiKeyHash,
      apiKeyPrefix: input.apiKeyPrefix,
    })
    .returning();
  return row as MerchantRow;
}

export async function findMerchantByEmail(email: string): Promise<MerchantRow | undefined> {
  const rows = await db
    .select()
    .from(merchants)
    .where(eq(merchants.email, email.toLowerCase().trim()))
    .limit(1);
  return rows[0] as MerchantRow | undefined;
}

export async function findMerchantById(id: string): Promise<MerchantRow | undefined> {
  const rows = await db.select().from(merchants).where(eq(merchants.id, id)).limit(1);
  return rows[0] as MerchantRow | undefined;
}

export async function findMerchantByApiKeyHash(apiKeyHash: string): Promise<MerchantRow | undefined> {
  const rows = await db.select().from(merchants).where(eq(merchants.apiKeyHash, apiKeyHash)).limit(1);
  return rows[0] as MerchantRow | undefined;
}

export async function updateMerchantApiKey(
  merchantId: string,
  apiKeyHash: string,
  apiKeyPrefix: string
): Promise<void> {
  await db
    .update(merchants)
    .set({ apiKeyHash, apiKeyPrefix, updatedAt: new Date() })
    .where(eq(merchants.id, merchantId));
}

export async function listAllMerchants(): Promise<MerchantRow[]> {
  return (await db.select().from(merchants)) as MerchantRow[];
}
