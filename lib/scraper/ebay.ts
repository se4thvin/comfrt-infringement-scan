import type { Listing } from './types';
import { str, num, parsePrice } from './amazon';

/* eBay is the least-certain endpoint shape in this project (flagged during
 * design review). The normalizer therefore:
 *   1. looks for the results array under several plausible keys,
 *   2. pulls each field from several candidate names,
 *   3. extracts the item id from the listing URL if no id field exists
 *      (eBay URLs end in /itm/<12-digit-id>),
 *   4. logs top-level keys when nothing normalizes, so a live-run mismatch is
 *      diagnosable in one look at the terminal. */

export function normalizeEbay(raw: unknown, sourceQuery: string): Listing[] {
  const body = raw as Record<string, unknown>;
  const arr =
    pickArray(body, [
      'results',
      'items',
      'organic_results',
      'search_results',
      'products',
    ]) ?? [];

  if (arr.length === 0) {
    console.warn(
      `[ebay] 0 results for "${sourceQuery}" — top-level keys: ${Object.keys(body ?? {}).join(', ')}`
    );
  }

  const out: Listing[] = [];
  for (const it of arr) {
    const item = it as Record<string, unknown>;
    const title = str(item.title) ?? str(item.name) ?? str(item.product_title);
    const url = str(item.url) ?? str(item.link) ?? str(item.product_url);
    const id =
      str(item.id) ??
      str(item.item_id) ??
      str(item.itemId) ??
      (url ? idFromUrl(url) : undefined);
    if (!id || !title || !url) continue;

    const priceRaw = item.price ?? item.price_string ?? item.current_price;
    const price = num(priceRaw) ?? parsePrice(typeof priceRaw === 'string' ? priceRaw : undefined);

    const format = (str(item.listing_type) ?? str(item.format) ?? '').toLowerCase();
    const isAuction =
      format.includes('auction') || item.is_auction === true || item.bids != null;

    out.push({
      key: `ebay:${id}`,
      platform: 'ebay',
      id,
      title,
      url,
      imageUrl: str(item.image) ?? str(item.image_url) ?? str(item.thumbnail),
      price,
      priceString: typeof priceRaw === 'string' ? priceRaw : price != null ? `$${price}` : undefined,
      sponsored: item.sponsored === true,
      listingType: isAuction ? 'auction' : format ? 'fixed' : 'unknown',
      sourceQuery,
    });
  }
  return out;
}

function idFromUrl(url: string): string | undefined {
  const m = url.match(/\/itm\/(?:[^/]*\/)?(\d{9,15})/);
  return m?.[1];
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
