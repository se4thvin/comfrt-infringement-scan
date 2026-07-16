/* One-time setup: download 8 authentic product images from comfrt.com into
 * lib/reference/images/. After this the pipeline never touches comfrt.com.
 *
 * Strategy: comfrt.com is a Shopify store, so /products.json is a public,
 * stable endpoint with exact product→image mappings — far more reliable than
 * scraping the homepage HTML (which lazy-loads product imagery via JS and
 * exposes only marketing banners to a plain fetch; the first version of this
 * script learned that the hard way and returned 1 usable image).
 *
 * The handles below are the flagship adult lines — the products counterfeiters
 * actually knock off. They must stay in sync with REFERENCE_TITLES in
 * lib/reference/products.ts. If a handle disappears from the catalog we warn
 * and continue; fewer, correct references beat padding with random items. */

import fs from 'node:fs/promises';
import path from 'node:path';

const CATALOG = 'https://comfrt.com/products.json?limit=250';
const OUT = path.join(process.cwd(), 'lib', 'reference', 'images');
const UA = { 'User-Agent': 'Mozilla/5.0 (reference-set setup script; one-time; contact: repo owner)' };

/** Flagship handles, in priority order. Keep in sync with REFERENCE_TITLES. */
const HANDLES = [
  'minimalist-hoodie',
  'halo-lightweight-oversized-hoodie',
  'snak-hoodie',
  'halo-airplane-mode-hoodie',
  'varsity-hoodie',
  'sunwashed-crew',
  'varsity-quarter-zip',
  'airplane-mode-straight-leg-sweatpants',
];

const res = await fetch(CATALOG, { headers: UA });
if (!res.ok) {
  console.error(`catalog fetch failed: HTTP ${res.status} — comfrt.com may be blocking or down.`);
  console.error('Fallback: save ~8 product images manually into lib/reference/images/.');
  process.exit(1);
}
const { products } = await res.json();
const byHandle = new Map(products.map((p) => [p.handle, p]));

await fs.mkdir(OUT, { recursive: true });
let n = 0;
for (const handle of HANDLES) {
  const product = byHandle.get(handle);
  if (!product?.images?.length) {
    console.warn(`missing from catalog: ${handle} — update HANDLES (and REFERENCE_TITLES)`);
    continue;
  }
  // First image = the primary product shot — the one marketplaces steal.
  const src = product.images[0].src;
  const url = src + (src.includes('?') ? '&' : '?') + 'width=800';
  try {
    const imgRes = await fetch(url, { headers: UA });
    if (!imgRes.ok) { console.warn(`failed ${handle}: HTTP ${imgRes.status}`); continue; }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length < 5_000) { console.warn(`skipped ${handle}: suspiciously small file`); continue; }
    const ext = (src.match(/\.(jpe?g|png|webp)/i)?.[1] ?? 'jpg').toLowerCase();
    await fs.writeFile(path.join(OUT, `ref-${n}.${ext}`), buf);
    console.log(`saved ref-${n}.${ext}  ←  ${product.title}`);
    n++;
  } catch (e) {
    console.warn(`failed ${handle}: ${e.message}`);
  }
}

console.log(`\n${n} reference images saved to lib/reference/images/`);
if (n < 4) console.warn('Fewer than 4 — consider adding images manually for a stronger reference set.');
