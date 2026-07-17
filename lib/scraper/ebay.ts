import type { Listing } from './types';
import { str, num, parsePrice } from './amazon';

/* eBay structured search /v2 — shape verified live 2026-07: a ROOT JSON
 * array (no wrapper object) of items carrying product_title / product_url /
 * image / item_price ({value,currency} or a {from,to} range) / extra_info
 * (buying-format text like "3 bids") / seller_name. No id field — extracted
 * from the URL (/itm/<12-digit-id>). Candidate-name fallbacks are kept from
 * the defensive first draft; they cost nothing and cover future drift.
 * On zero results the top-level shape is logged so a mismatch is diagnosable
 * in one look at the terminal. */

export function normalizeEbay(raw: unknown, sourceQuery: string): Listing[] {
  const body = raw as Record<string, unknown>;
  const arr = Array.isArray(raw)
    ? raw
    : pickArray(body, [
        'results',
        'items',
        'organic_results',
        'search_results',
        'products',
      ]) ?? [];

  if (arr.length === 0) {
    const shape = Array.isArray(raw)
      ? `empty root array`
      : `top-level keys: ${Object.keys(body ?? {}).join(', ')}`;
    console.warn(`[ebay] 0 results for "${sourceQuery}" — ${shape}`);
  }

  const out: Listing[] = [];
  for (const it of arr) {
    const item = it as Record<string, unknown>;
    const title = str(item.product_title) ?? str(item.title) ?? str(item.name);
    const url = str(item.product_url) ?? str(item.url) ?? str(item.link);
    const id =
      str(item.id) ??
      str(item.item_id) ??
      str(item.itemId) ??
      (url ? idFromUrl(url) : undefined);
    if (!id || !title || !url) continue;

    // item_price is an object: {value, currency} or {from, to} for ranges.
    // A range uses `from` — the lower bound is what a buyer sees first and
    // the conservative input for the price-anomaly signal.
    const priceObj = (item.item_price ?? undefined) as Record<string, unknown> | undefined;
    const priceRaw = item.price ?? item.price_string ?? item.current_price;
    const price =
      num(priceObj?.value) ??
      parsePrice(str(priceObj?.value)) ??
      num(priceObj?.from) ??
      parsePrice(str(priceObj?.from)) ??
      num(priceRaw) ??
      parsePrice(typeof priceRaw === 'string' ? priceRaw : undefined);

    const format = (
      str(item.extra_info) ??
      str(item.listing_type) ??
      str(item.format) ??
      ''
    ).toLowerCase();
    const isAuction =
      format.includes('auction') ||
      /\bbids?\b/.test(format) ||
      item.is_auction === true ||
      item.bids != null;

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
      condition: parseCondition(str(item.condition)),
      sourceQuery,
    });
  }
  return out;
}

/* Live finding (2026-07): for niche queries like "comfrt hoodie", eBay serves
 * its NEW card markup (s-card / su-card-container), which ScraperAPI's
 * structured extractor cannot parse — it returns the right item COUNT but
 * every object empty. (Generic queries like "iphone" get the legacy layout
 * and extract fine, which is what makes this a trap: the endpoint looks
 * healthy until you send it the query class this tool exists for.)
 * This detector + the HTML parser below are the recovery path. */

export function structuredCameBackEmpty(raw: unknown): boolean {
  const arr = Array.isArray(raw)
    ? raw
    : (raw as Record<string, unknown>)?.results;
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.every(
    (it) => typeof it === 'object' && it !== null && Object.keys(it).length === 0
  );
}

/** Parse eBay's new s-card search markup. Regex over stable anchors
 *  (data-listingid, /itm/<id>, s-card__price) rather than a DOM library —
 *  deliberately dependency-light, and loud when it parses nothing so markup
 *  drift is diagnosable from the terminal. */
export function parseEbayHtml(html: string, sourceQuery: string): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  // data-listingid is the one attribute that survives eBay's quote-style
  // variance; each split chunk runs until the next card starts.
  const chunks = html.split(/data-listingid=["']?/).slice(1);

  for (const card of chunks) {
    const id = card.match(/^(\d{9,15})/)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const title =
      decodeEntities(card.match(/\balt="([^"]{5,250})"/)?.[1]) ??
      decodeEntities(card.match(/s-card__title[^>]*>(?:<[^>]+>)*([^<]{3,250})</)?.[1]);
    const url = card.match(/href=["']?(https:\/\/www\.ebay\.com\/itm\/\d+)[^"'\s>]*/)?.[1];
    const imageUrl = card.match(
      /(?:src|data-defer-load)=["']?(https:\/\/i\.ebayimg\.com\/[^"'\s>]+)/
    )?.[1];
    const priceString = decodeEntities(card.match(/s-card__price[^>]*>([^<]{1,40})</)?.[1]);
    // Condition renders as its own styled-text span ("Pre-Owned", "Brand New",
    // "New with tags", "New (Other)") — match the phrases, not the markup.
    const condText = card.match(/>\s*((?:Pre-Owned|Brand New|New \(Other\)|New with(?:out)? tags|Open Box|Refurbished|For parts)[^<]{0,30})</i)?.[1];
    if (!title || !url) continue;

    out.push({
      key: `ebay:${id}`,
      platform: 'ebay',
      id,
      title,
      url, // /itm/<id> stripped of tracking params — the stable takedown target
      imageUrl,
      price: parsePrice(priceString),
      priceString,
      // Not detectable in the new markup: eBay plants a transparent decoy
      // ("derosnopS") in EVERY card and renders the real label as homoglyph
      // text inside a base64 SVG. Guessing would mislabel organic listings,
      // and nothing downstream scores on it — so we don't claim it.
      sponsored: undefined,
      listingType: /\b\d+\s*bids?\b/i.test(card) ? 'auction' : 'fixed',
      condition: parseCondition(condText),
      sourceQuery,
    });
  }

  if (out.length === 0) {
    console.warn(
      `[ebay-html] parsed 0 cards for "${sourceQuery}" — eBay markup may have drifted (looked for data-listingid)`
    );
  }
  return out;
}

function parseCondition(s?: string): 'new' | 'used' | 'unknown' {
  if (!s) return 'unknown';
  const t = s.toLowerCase();
  if (/pre-owned|used|refurbished|for parts/.test(t)) return 'used';
  if (/new/.test(t)) return 'new'; // covers Brand New / New (Other) / with(out) tags
  return 'unknown';
}

function decodeEntities(s?: string): string | undefined {
  if (!s) return undefined;
  const t = s
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
  return t || undefined;
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
