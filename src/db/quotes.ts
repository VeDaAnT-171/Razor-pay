/**
 * src/db/quotes.ts — repository layer for `quotes`.
 */

import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { quotes } from "./schema";

export interface QuoteRow {
  id: string;
  merchantId: string;
  sku: string;
  unitPriceInr: number;
  issuedAt: Date;
  validForSec: number;
}

export async function insertQuote(
  merchantId: string,
  sku: string,
  unitPriceInr: number,
  validForSec: number
): Promise<QuoteRow> {
  const [row] = await db
    .insert(quotes)
    .values({ id: randomUUID(), merchantId, sku, unitPriceInr, validForSec })
    .returning();
  return row as QuoteRow;
}

export async function findQuote(merchantId: string, quoteId: string): Promise<QuoteRow | undefined> {
  const rows = await db
    .select()
    .from(quotes)
    .where(and(eq(quotes.merchantId, merchantId), eq(quotes.id, quoteId)))
    .limit(1);
  return rows[0] as QuoteRow | undefined;
}
