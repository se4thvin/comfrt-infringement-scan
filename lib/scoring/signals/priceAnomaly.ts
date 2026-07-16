import { AUTHENTIC_PRICE } from '../../reference/products';
import type { Listing, SignalResult } from '../../scraper/types';

/* Price anomaly: authentic Comfrt garments retail in a known band; a
 * "Comfrt hoodie" at $12 is a strong counterfeit tell.
 *
 * Two honest caveats are built in rather than papered over:
 *  - GATED on category confirmation (titleSimilarity or a brand hit): a cheap
 *    unrelated item caught by the query is not "anomalously priced".
 *  - HALVED for eBay auctions, where low prices are structurally expected
 *    (used items, early bids). This makes the signal partially dependent on
 *    the text signals — acknowledged in the README, preferable to the false
 *    positives the ungated version produces. */

export function priceAnomaly(
  listing: Listing,
  categoryConfirmed: boolean
): SignalResult {
  if (listing.price == null) {
    return { p: 0, raw: { price: null }, unavailable: true };
  }
  if (!categoryConfirmed) {
    return {
      p: 0,
      raw: { price: listing.price, gated: 'category not confirmed by text signals' },
    };
  }

  const { min } = AUTHENTIC_PRICE;
  const ratio = listing.price / min;

  // ratio ≥ 1 → in/above authentic band → no anomaly.
  // ratio → 0 → deeply below band → strong anomaly. Linear ramp is fine here;
  // the raw ratio is exposed for inspection.
  let p = ratio >= 1 ? 0 : (1 - ratio) * 0.75;

  const auction = listing.listingType === 'auction';
  if (auction) p *= 0.5;

  return {
    p,
    raw: {
      price: listing.price,
      authenticFloor: min,
      ratioToFloor: Math.round(ratio * 100) / 100,
      auctionAdjusted: auction ? 1 : 0,
    },
    reason:
      p >= 0.3
        ? `Priced at $${listing.price} — far below the authentic ~$${min}+ retail floor${auction ? ' (discounted: auction format)' : ''}`
        : undefined,
  };
}
