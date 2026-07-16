/* The authentic reference set.
 *
 * Images: downloaded once via `npm run fetch-reference`, which scrapes
 * comfrt.com product pages for og/product images and saves ~8 of them to
 * lib/reference/images/. After that the pipeline has zero runtime network
 * dependency on comfrt.com. (Committing the images to the repo was ruled out
 * only because this project was authored in an environment without access to
 * comfrt.com — if you can, commit them and delete the script.)
 *
 * Titles: canonical product names used by the title-similarity signal.
 * Price band: authentic Comfrt hoodies retail well above typical knockoff
 * prices; the band below feeds the price-anomaly signal. */

export const REFERENCE_TITLES = [
  'Comfrt Cloud Hoodie',
  'Comfrt Signature Hoodie',
  'Comfrt Cloud Blanket Hoodie',
  'Comfrt Cloud Half Zip',
  'Comfrt Cloud Sweatpants',
  'Comfrt Oversized Hoodie',
  'Comfrt Cloud Crewneck Sweatshirt',
  'Comfrt Cloud Shorts',
];

export const BRAND = 'comfrt';

/** Authentic retail band (USD). Listings priced far below MIN for a matching
 *  product category are suspicious. Verify against comfrt.com when you run
 *  fetch-reference — adjust if their pricing has moved. */
export const AUTHENTIC_PRICE = { min: 50, typical: 70 };

/** Pages the fetch-reference script scrapes for product images. */
export const REFERENCE_PAGES = [
  'https://comfrt.com/',
  'https://comfrt.com/collections/all',
];
