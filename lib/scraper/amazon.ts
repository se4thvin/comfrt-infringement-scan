import type { Listing } from './types';

/* ScraperAPI's structured Amazon search returns { results: [...] } where each
 * item carries asin/name/image/price fields. Field names have drifted across
 * versions, so pull from candidates rather than assuming one shape. If the
 * response yields zero listings, the raw top-level keys are logged so a shape
 * mismatch is diagnosable from the terminal instead of failing silently. */

export function normalizeAmazon(raw: unknown, sourceQuery: string): Listing[] {
  const body = raw as Record<string, unknown>;
  const arr =
    pickArray(body, ['results', 'organic_results', 'products', 'items']) ?? [];

  if (arr.length === 0) {
    console.warn(
      `[amazon] 0 results for "${sourceQuery}" — top-level keys: ${Object.keys(body ?? {}).join(', ')}`
    );
  }

  const out: Listing[] = [];
  for (const it of arr) {
    const item = it as Record<string, unknown>;
    const asin = str(item.asin) ?? str(item.ASIN);
    const title = str(item.name) ?? str(item.title) ?? str(item.product_title);
    if (!asin || !title) continue;

    const priceNum =
      num(item.price) ?? parsePrice(str(item.price_string) ?? str(item.price));

    // Sponsored results carry a giant /sspa/click redirect as their URL
    // (seen live 2026-07). The canonical /dp/<asin> link is the stable
    // takedown target — that's what this tool exists to produce.
    const rawUrl = str(item.url);
    const url =
      rawUrl && !rawUrl.includes('/sspa/') ? rawUrl : `https://www.amazon.com/dp/${asin}`;

    out.push({
      key: `amazon:${asin}`,
      platform: 'amazon',
      id: asin,
      title,
      url,
      imageUrl: str(item.image) ?? str(item.image_url) ?? str(item.thumbnail),
      price: priceNum,
      priceString: str(item.price_string) ?? (priceNum != null ? `$${priceNum}` : undefined),
      sponsored:
        item.type === 'ad' || item.sponsored === true || rawUrl?.includes('/sspa/') === true,
      listingType: 'fixed',
      sourceQuery,
    });
  }
  return out;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}
export function parsePrice(s?: string): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : undefined;
}
function pickArray(
  body: Record<string, unknown> | null | undefined,
  keys: string[]
): unknown[] | undefined {
  if (!body) return undefined;
  for (const k of keys) {
    if (Array.isArray(body[k])) return body[k] as unknown[];
  }
  return undefined;
}
