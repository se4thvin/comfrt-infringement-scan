/* One-time setup: scrape ~8 product images from comfrt.com into
 * lib/reference/images/. After this the pipeline never touches comfrt.com.
 *
 * Strategy: fetch the homepage + /collections/all, pull <img> srcs and
 * og:image tags pointing at the Shopify CDN, dedupe by base filename
 * (Shopify serves many sizes of one image), keep the first 8 product-looking
 * images, download at a reasonable width. No dependencies — regex over HTML
 * is fine for a one-shot setup script (do not do this in the pipeline). */

import fs from 'node:fs/promises';
import path from 'node:path';

const PAGES = ['https://comfrt.com/', 'https://comfrt.com/collections/all'];
const OUT = path.join(process.cwd(), 'lib', 'reference', 'images');
const WANT = 8;
const UA = { 'User-Agent': 'Mozilla/5.0 (reference-set setup script; one-time; contact: repo owner)' };

const seenBase = new Set();
const picked = [];

for (const page of PAGES) {
  if (picked.length >= WANT) break;
  let html;
  try {
    const res = await fetch(page, { headers: UA });
    if (!res.ok) { console.warn(`skip ${page}: HTTP ${res.status}`); continue; }
    html = await res.text();
  } catch (e) {
    console.warn(`skip ${page}: ${e.message}`);
    continue;
  }

  const urls = [
    ...html.matchAll(/(?:src|content|srcset)=["']([^"']*(?:cdn\/shop|cdn\.shopify)[^"'\s]*\.(?:jpe?g|png|webp)[^"'\s]*)/gi),
  ].map((m) => m[1]);

  for (let u of urls) {
    if (picked.length >= WANT) break;
    if (u.startsWith('//')) u = 'https:' + u;
    const base = u.split('/').pop().split('?')[0].replace(/_(\d+x\d*|\d*x\d+)\./, '.');
    if (seenBase.has(base)) continue;
    // Skip obvious non-product assets
    if (/logo|icon|favicon|badge|payment|flag/i.test(base)) continue;
    seenBase.add(base);
    picked.push(u.replace(/(width=)\d+/, '$1800'));
  }
}

if (picked.length === 0) {
  console.error(
    'No images found — comfrt.com may have changed or blocked the request.\n' +
    'Fallback: save ~8 product images manually into lib/reference/images/.'
  );
  process.exit(1);
}

await fs.mkdir(OUT, { recursive: true });
let n = 0;
for (const u of picked) {
  try {
    const res = await fetch(u, { headers: UA });
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5_000) continue; // tracking pixels / tiny assets
    const ext = (u.match(/\.(jpe?g|png|webp)/i)?.[1] ?? 'jpg').toLowerCase();
    await fs.writeFile(path.join(OUT, `ref-${n}.${ext}`), buf);
    console.log(`saved ref-${n}.${ext}  ←  ${u}`);
    n++;
  } catch (e) {
    console.warn(`failed ${u}: ${e.message}`);
  }
}
console.log(`\n${n} reference images saved to lib/reference/images/`);
if (n < 4) console.warn('Fewer than 4 — consider adding images manually for a stronger reference set.');
