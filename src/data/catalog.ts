/**
 * src/data/catalog.ts
 *
 * Seed data only. Every merchant gets their own copy of this catalog and
 * bundle-rule set in Postgres at signup time (see
 * services/catalog.ts#seedMerchantCatalog) — nothing reads these arrays
 * directly at request time any more. Kept here, unchanged from the
 * single-tenant prototype, so a fresh signup isn't an empty store.
 */

export interface Product {
  sku: string;
  name: string;
  description: string;
  category: string;
  mcc: string;
  price_inr: number;
  inventory_count: number;
  margin_pct: number; // gross margin — caps how much discount the negotiation engine can grant
  image_url: string;
  driftEnabled?: boolean;
}

export const DEFAULT_CATALOG: Product[] = [
  {
    sku: "SKU-HEADPHONE-700",
    name: "Aurora Wireless Headphones",
    description: "Over-ear ANC wireless headphones, 40h battery.",
    category: "Electronics > Audio",
    mcc: "5732",
    price_inr: 700,
    inventory_count: 42,
    margin_pct: 28,
    image_url: "https://example-merchant.test/img/aurora-headphones.jpg",
    driftEnabled: true,
  },
  {
    sku: "SKU-CASE-199",
    name: "Aurora Travel Case",
    description: "Hard-shell carrying case, fits Aurora Headphones.",
    category: "Electronics > Accessories",
    mcc: "5732",
    price_inr: 199,
    inventory_count: 120,
    margin_pct: 45,
    image_url: "https://example-merchant.test/img/aurora-case.jpg",
  },
  {
    sku: "SKU-CABLE-99",
    name: "USB-C Braided Cable (1.5m)",
    description: "Fast-charge braided USB-C cable.",
    category: "Electronics > Accessories",
    mcc: "5732",
    price_inr: 99,
    inventory_count: 300,
    margin_pct: 60,
    image_url: "https://example-merchant.test/img/usbc-cable.jpg",
  },
  {
    sku: "SKU-SPEAKER-2499",
    name: "Nimbus Portable Speaker",
    description: "IPX7 waterproof Bluetooth speaker, 20h battery.",
    category: "Electronics > Audio",
    mcc: "5732",
    price_inr: 2499,
    inventory_count: 18,
    margin_pct: 22,
    image_url: "https://example-merchant.test/img/nimbus-speaker.jpg",
  },
  {
    sku: "SKU-STAND-349",
    name: "Adjustable Desk Phone Stand",
    description: "Aluminium adjustable stand, foldable.",
    category: "Electronics > Accessories",
    mcc: "5732",
    price_inr: 349,
    inventory_count: 80,
    margin_pct: 50,
    image_url: "https://example-merchant.test/img/desk-stand.jpg",
  },
];

/** Complementary-product map driving the upsell/cross-sell engine. */
export const DEFAULT_BUNDLE_RULES: Record<string, { sku: string; reason: string }[]> = {
  "SKU-HEADPHONE-700": [
    { sku: "SKU-CASE-199", reason: "Frequently bought with Aurora Headphones — protects during travel." },
    { sku: "SKU-CABLE-99", reason: "Spare fast-charge cable for the headphone case's USB-C port." },
  ],
  "SKU-SPEAKER-2499": [
    { sku: "SKU-CABLE-99", reason: "Nimbus Speaker charges via USB-C — a spare cable is commonly added." },
  ],
  "SKU-CASE-199": [
    { sku: "SKU-HEADPHONE-700", reason: "This case is sized for Aurora Headphones." },
  ],
};
