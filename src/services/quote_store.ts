/**
 * src/services/quote_store.ts
 *
 * Tracks short-lived, merchant-scoped price quotes issued to agents (via
 * the catalog's get_product_quote / /agent/v1/catalog/quote/:sku). The
 * protocol bridge and guardrail gate use this to detect price drift
 * between quote-time and checkout-time — the mechanism behind the
 * mandate-breach simulation.
 */

import * as repo from "../db/quotes";
import { findProduct } from "./catalog";

export interface Quote {
  quote_id: string;
  sku: string;
  unit_price_inr: number;
  issued_at: number; // epoch ms
  valid_for_sec: number;
}

const QUOTE_VALID_FOR_SEC = 120;

function toQuote(row: repo.QuoteRow): Quote {
  return {
    quote_id: row.id,
    sku: row.sku,
    unit_price_inr: row.unitPriceInr,
    issued_at: row.issuedAt.getTime(),
    valid_for_sec: row.validForSec,
  };
}

export async function issueQuote(merchantId: string, sku: string): Promise<Quote | undefined> {
  const product = await findProduct(merchantId, sku);
  if (!product) return undefined;
  const row = await repo.insertQuote(merchantId, sku, product.price_inr, QUOTE_VALID_FOR_SEC);
  return toQuote(row);
}

export async function getQuote(merchantId: string, quoteId: string): Promise<Quote | undefined> {
  const row = await repo.findQuote(merchantId, quoteId);
  return row ? toQuote(row) : undefined;
}

export function isQuoteExpired(quote: Quote): boolean {
  const ageSec = (Date.now() - quote.issued_at) / 1000;
  return ageSec > quote.valid_for_sec;
}

export const QUOTE_VALID_FOR_SEC_DEFAULT = QUOTE_VALID_FOR_SEC;
