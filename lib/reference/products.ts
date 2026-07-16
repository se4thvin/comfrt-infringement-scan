/* The authentic reference set.
 *
 * Images: downloaded once via `npm run fetch-reference` (Shopify
 * /products.json → primary product shot per flagship handle) and committed to
 * the repo, so the pipeline has zero runtime network dependency on comfrt.com.
 *
 * Titles: canonical product names used by the title-similarity signal —
 * verified against the live catalog (2026-07). Must stay in sync with the
 * HANDLES list in scripts/fetch-reference.mjs.
 *
 * Price band: feeds the price-anomaly signal. */

export const REFERENCE_TITLES = [
  'Comfrt Minimalist Hoodie',
  'Comfrt Halo Lightweight Oversized Hoodie',
  'Comfrt Snak Hoodie',
  'Comfrt Halo Lightweight Airplane Mode Hoodie',
  'Comfrt Varsity Hoodie',
  'Comfrt Sunwashed Crew',
  'Comfrt Varsity Quarter Zip',
  'Comfrt Airplane Mode Straight Leg Sweatpants',
];

export const BRAND = 'comfrt';

/** Authentic retail band (USD), verified against comfrt.com's live catalog
 *  (2026-07): adult hoodies/crews cluster $39–69 with $49 typical. Listings
 *  priced far below MIN for a matching product category are suspicious. */
export const AUTHENTIC_PRICE = { min: 39, typical: 49 };
