/**
 * src/mcp/server.ts
 *
 * A real MCP (Model Context Protocol) server exposing three tools —
 * search_catalog, get_product_quote, check_inventory — over stdio, so any
 * MCP-capable AI buyer agent (Claude, an ACP agent runtime, etc.) can
 * browse and quote a merchant's catalog directly as tool calls instead of
 * hand-rolled HTTP.
 *
 * Multi-tenant: this process is bound to exactly ONE merchant, identified
 * by the API key in A_COS_API_KEY (the same key issued at signup / shown
 * in Settings -> Rotate API key on the dashboard). A merchant wiring up
 * their own AI agent integration runs their own copy of this process with
 * their own key — exactly the credential an HTTP agent would present as
 * `x-api-key`, just consumed over stdio instead.
 *
 * Run standalone with: A_COS_API_KEY=acos_live_... npm run mcp
 * (or `npm run build && A_COS_API_KEY=... npm run mcp:build-run`)
 * and point an MCP client at this process via stdio.
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { checkInventory, getProductQuote, searchCatalog } from "../services/mcp_catalog";
import { resolveMerchantByApiKey } from "../services/auth";

const server = new Server(
  { name: "razorpay-a-cos-catalog", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_catalog",
      description:
        "Search the merchant's product catalog by free-text query, category, and/or max price (INR).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search term" },
          category: { type: "string", description: "Category filter, e.g. 'Electronics > Audio'" },
          max_price_inr: { type: "number", description: "Maximum unit price in INR" },
        },
      },
    },
    {
      name: "get_product_quote",
      description:
        "Issue a fresh, short-lived (quote_valid_for_sec: 120) price quote for a SKU, returning a quote_id the checkout call must reference.",
      inputSchema: {
        type: "object",
        properties: { sku: { type: "string" } },
        required: ["sku"],
      },
    },
    {
      name: "check_inventory",
      description: "Check live stock availability for a SKU and optional requested quantity.",
      inputSchema: {
        type: "object",
        properties: {
          sku: { type: "string" },
          requested_qty: { type: "number" },
        },
        required: ["sku"],
      },
    },
  ],
}));

function makeToolHandler(merchantId: string) {
  return async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const { name, arguments: args = {} } = request.params;

    switch (name) {
      case "search_catalog": {
        const result = await searchCatalog(merchantId, args as any);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_product_quote": {
        const result = await getProductQuote(merchantId, (args as any).sku);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "check_inventory": {
        const result = await checkInventory(merchantId, (args as any).sku, (args as any).requested_qty ?? 1);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  };
}

async function main() {
  const apiKey = process.env.A_COS_API_KEY;
  if (!apiKey) {
    console.error(
      "A_COS_API_KEY is not set. This MCP server is bound to one merchant — pass the API key shown at " +
        "signup (or rotated from the dashboard) as A_COS_API_KEY."
    );
    process.exit(1);
  }
  const merchant = await resolveMerchantByApiKey(apiKey);
  if (!merchant) {
    console.error("A_COS_API_KEY did not match any merchant — check the key and try again.");
    process.exit(1);
  }

  server.setRequestHandler(CallToolRequestSchema, makeToolHandler(merchant.merchant_id));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`A-COS MCP catalog server running on stdio for merchant "${merchant.name}" (${merchant.merchant_id})`);
}

main().catch((err) => {
  console.error("Fatal MCP server error:", err);
  process.exit(1);
});
