/**
 * src/services/mcp_catalog.ts
 *
 * Two things live here:
 *
 * 1. Plain, merchant-scoped functions (searchCatalog / getProductQuote /
 *    checkInventory) that are the single source of truth for catalog
 *    behavior. Called directly by Fastify HTTP routes AND wrapped as MCP
 *    tools in src/mcp/server.ts — so an AI buyer agent can reach this
 *    merchant either over plain HTTP/OpenAPI or over MCP with identical
 *    results.
 *
 * 2. Machine-readable catalog builders: Schema.org/Commerce JSON-LD and a
 *    minimal OpenAPI v3 document describing /agent/v1/catalog.
 */

import { Product } from "../data/catalog";
import { listCatalog, findProduct, searchCatalog as searchCatalogService, SearchCatalogArgs } from "./catalog";
import { issueQuote, Quote } from "./quote_store";

export { SearchCatalogArgs };

export async function searchCatalog(merchantId: string, args: SearchCatalogArgs = {}): Promise<Product[]> {
  return searchCatalogService(merchantId, args);
}

/* ------------------------------------------------------------------ */
/* Tool: get_product_quote                                             */
/* ------------------------------------------------------------------ */

export interface ProductQuoteResult {
  sku: string;
  name: string;
  quote_id: string;
  unit_price_inr: number;
  currency: "INR";
  quote_valid_for_sec: number;
  quote_issued_at: string;
}

export async function getProductQuote(merchantId: string, sku: string): Promise<ProductQuoteResult | { error: string }> {
  const product = await findProduct(merchantId, sku);
  if (!product) return { error: `Unknown SKU: ${sku}` };

  const quote = (await issueQuote(merchantId, sku)) as Quote;
  return {
    sku: product.sku,
    name: product.name,
    quote_id: quote.quote_id,
    unit_price_inr: quote.unit_price_inr,
    currency: "INR",
    quote_valid_for_sec: quote.valid_for_sec,
    quote_issued_at: new Date(quote.issued_at).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Tool: check_inventory                                               */
/* ------------------------------------------------------------------ */

export interface InventoryResult {
  sku: string;
  in_stock: boolean;
  available_quantity: number;
}

export async function checkInventory(merchantId: string, sku: string, requestedQty = 1): Promise<InventoryResult | { error: string }> {
  const product = await findProduct(merchantId, sku);
  if (!product) return { error: `Unknown SKU: ${sku}` };
  return {
    sku: product.sku,
    in_stock: product.inventory_count >= requestedQty,
    available_quantity: product.inventory_count,
  };
}

/* ------------------------------------------------------------------ */
/* Product detail — the full AI Commerce Contract for one SKU          */
/* ------------------------------------------------------------------ */

export async function getProductDetail(merchantId: string, sku: string): Promise<Record<string, unknown> | { error: string }> {
  const product = await findProduct(merchantId, sku);
  if (!product) return { error: `Unknown SKU: ${sku}` };
  return {
    sku: product.sku,
    name: product.name,
    description: product.description,
    category: product.category,
    pricing: { amount: product.price_inr, currency: "INR" },
    inventory: { available: product.inventory_count },
    commerce_capabilities: {
      discoverable: true,
      purchasable: true,
      negotiable: true,
      recommendable: true,
    },
    purchase_constraints: {
      min_quantity: 1,
      max_quantity: 3,
      max_discount_pct: Math.min(product.margin_pct, 10),
    },
    payment_capabilities: {
      agent_payment_supported: true,
      supported_methods: ["upi", "card", "netbanking", "wallet"],
    },
    fulfillment: { standard_days: "3-5 business days", regions: ["IN"] },
    returns: { window_days: 7 },
  };
}

/* ------------------------------------------------------------------ */
/* Schema.org / Commerce JSON-LD catalog                               */
/* ------------------------------------------------------------------ */

export async function buildJsonLdCatalog(merchantId: string, merchantName: string) {
  const catalog = await listCatalog(merchantId);
  return {
    "@context": "https://schema.org",
    "@type": "OfferCatalog",
    name: `${merchantName} — Agent-Readable Catalog`,
    itemListElement: catalog.map((p, idx) => ({
      "@type": "Offer",
      position: idx + 1,
      sku: p.sku,
      itemOffered: {
        "@type": "Product",
        name: p.name,
        description: p.description,
        sku: p.sku,
        category: p.category,
        image: p.image_url,
      },
      price: p.price_inr,
      priceCurrency: "INR",
      availability:
        p.inventory_count > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      inventoryLevel: {
        "@type": "QuantitativeValue",
        value: p.inventory_count,
      },
    })),
  };
}

/* ------------------------------------------------------------------ */
/* OpenAPI v3 fragment for the agent-readable catalog surface          */
/* ------------------------------------------------------------------ */

export function buildOpenApiSpec(baseUrl: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "Razorpay A-COS — Agent-Readable Catalog",
      version: "0.1.0",
      description:
        "Machine-readable catalog + quoting surface for AI buyer agents transacting via ACP / AP2 / x402 / NPCI UAP. " +
        "Every request is scoped to the merchant identified by the x-api-key header.",
    },
    servers: [{ url: baseUrl }],
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
    paths: {
      "/agent/v1/catalog": {
        get: {
          summary: "List catalog as Schema.org/Commerce JSON-LD",
          operationId: "listCatalog",
          responses: { "200": { description: "OK" } },
        },
      },
      "/agent/v1/catalog/search": {
        get: {
          summary: "Search catalog",
          operationId: "searchCatalog",
          parameters: [
            { name: "query", in: "query", schema: { type: "string" } },
            { name: "category", in: "query", schema: { type: "string" } },
            { name: "max_price_inr", in: "query", schema: { type: "number" } },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
      "/agent/v1/catalog/quote/{sku}": {
        get: {
          summary: "Issue a short-lived price quote (quote_valid_for_sec: 120)",
          operationId: "getProductQuote",
          parameters: [{ name: "sku", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" } },
        },
      },
      "/agent/v1/catalog/inventory/{sku}": {
        get: {
          summary: "Check live inventory for a SKU",
          operationId: "checkInventory",
          parameters: [
            { name: "sku", in: "path", required: true, schema: { type: "string" } },
            { name: "qty", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
}
