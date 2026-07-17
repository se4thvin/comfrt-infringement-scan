import type { Listing, ScoredListing, SignalResult } from '../scraper/types';
import { titleSimilarity } from './signals/titleSimilarity';
import { brandFuzzy } from './signals/brandFuzzy';
import { priceAnomaly } from './signals/priceAnomaly';
import { hamming, type PHash } from './signals/imageHash';
import type { ReferenceSet } from '../reference/prepare';

/* Combination model — the deliberate choices, stated:
 *
 * NOISY-OR, not weighted mean: P = 1 − ∏(1 − wᵢ·pᵢ).
 *   Independent-ish pieces of evidence should compound upward; a weighted
 *   mean lets a strong signal be averaged down by weak ones, which produces
 *   exactly the wrong ranking for "stolen photo, rewritten title" listings.
 *
 * DOMINANT-SIGNAL FLOOR: a near-exact perceptual image match (Hamming ≤ 6/63)
 *   is sufficient evidence on its own — the probability is floored at 0.88
 *   regardless of other signals.
 *
 * WEIGHTS cap each signal's max contribution: image is the most trustworthy
 *   (0.9), brand analysis is strong (0.8), title and price corroborate
 *   (0.55 / 0.5). Weights are judgment, not calibration — raw values are
 *   surfaced so the judgment is inspectable.
 */

const W = { image: 0.9, brand: 0.8, title: 0.55, price: 0.5, provenance: 0.4 };

const HAMMING_EXACT = 6;   // ≤ this → dominant floor
const HAMMING_NEAR = 14;   // ≤ this → strong-but-not-conclusive image evidence
const FLOOR = 0.88;

export function scoreText(listing: Listing): ScoredListing {
  const title = titleSimilarity(listing.title);
  const brand = brandFuzzy(listing.title);

  // Interaction rule (ground-truthed in live validation): the brand name on a
  // listing whose title matches NO actual product is keyword-squatting — e.g.
  // a $9.99 "Generic" hoodie dress stuffing "Comfrt Pullover" into its title.
  // That's a stronger infringement tell than brand + faithful product title,
  // which on eBay usually means authentic resale. USED listings are exempt:
  // squatting is a new-goods game, and second-hand sellers describe items
  // generically ("Men's XL Gray Pullover Hoodie") without naming the line —
  // without the exemption this rule mislabeled 25% of a live scan. Signals
  // stay independently measured (raw untouched); this is a documented
  // combiner rule, like the category gate below.
  const titleSim = Number(title.raw.bestSimilarity ?? 0);
  if (
    brand.raw.exactMention === 1 &&
    !brand.raw.evasionPhrase &&
    titleSim < 0.35 &&
    listing.condition !== 'used'
  ) {
    brand.p = Math.max(brand.p, 0.7);
    brand.reason = `Brand name "comfrt" used on a product matching no authentic listing (keyword squatting)`;
  }

  const categoryConfirmed = title.p >= 0.25 || brand.p >= 0.45;
  const price = priceAnomaly(listing, categoryConfirmed);

  const signals: Record<string, SignalResult> = {
    imageSimilarity: { p: 0, raw: { status: 'pending' }, unavailable: true },
    brandAnalysis: brand,
    titleSimilarity: title,
    priceAnomaly: price,
    provenance: provenance(listing, brand),
  };
  return assemble(listing, signals, true);
}

/* Provenance: where do these goods come from? A 5th, contextual signal born
 * from live validation — the evidence that separated counterfeit from legal
 * resale was never in the title. Two cheap tells from search-page data:
 *  - a NEW brand-related item shipping from outside the US (Comfrt sells
 *    domestically; overseas-shipped "new" branded goods are the classic
 *    counterfeit channel);
 *  - template-titled batch inventory (applyBatchEvidence below): one seller
 *    listing "COMFRT Minimalist Hoodie in {color} - Size {n}" across many
 *    variants has manufacturer-depth inventory, not a closet cleanout.
 * Modest weight (0.4): these corroborate, they do not convict. */
function provenance(listing: Listing, brand: SignalResult): SignalResult {
  const brandRelated = brand.p >= 0.45;
  const notUsed = listing.condition !== 'used';
  const loc = listing.itemLocation;
  const foreign = loc != null && !/united states|usa|u\.s\./i.test(loc);

  if (loc == null) {
    return { p: 0, raw: { status: 'no location data', batchSize: null }, unavailable: true };
  }
  const fires = foreign && brandRelated && notUsed;
  return {
    p: fires ? 0.5 : 0,
    raw: { itemLocation: loc, batchSize: null },
    reason: fires
      ? `New brand-related listing shipping from "${loc}" — outside the brand's domestic retail channel`
      : undefined,
  };
}

/** Group key for template-title detection: tokens minus sizes/numbers, first
 *  four kept + token count. Decorated inventory titles ("...in Panther - Size
 *  2XL") collide; organic resale titles rarely do. ≥5 tokens required — short
 *  plain titles ("Comfrt Minimalist Hoodie") collide across unrelated sellers. */
export function templateKey(title: string): string | null {
  const SIZES = /^(xxs|xs|s|m|l|xl|xxl|\dxl?|small|medium|large|x-large|xx-large|size|sz)$/;
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !SIZES.test(t) && !/^\d+$/.test(t));
  if (tokens.length < 5) return null;
  return `${tokens.slice(0, 4).join(' ')}|${tokens.length}`;
}

/** Upgrade the provenance signal once the whole result set is known: this
 *  listing's title template appears `batchSize` times as new-condition
 *  inventory. Called from the job's finalization pass. */
export function applyBatchEvidence(scored: ScoredListing, batchSize: number): ScoredListing {
  if (batchSize < 3) return scored;
  if (scored.listing.condition === 'used') return scored;
  if ((scored.signals.brandAnalysis?.p ?? 0) < 0.45) return scored;

  const prev = scored.signals.provenance ?? { p: 0, raw: {} };
  const provenance: SignalResult = {
    p: Math.max(prev.p, 0.45),
    raw: { ...prev.raw, batchSize },
    reason:
      `One of ${batchSize} near-identical new listings (template title) — ` +
      `inventory-scale seller, not an individual resale` +
      (prev.reason ? `; ${prev.reason.charAt(0).toLowerCase()}${prev.reason.slice(1)}` : ''),
  };
  return assemble(scored.listing, { ...scored.signals, provenance }, scored.provisional);
}

export function applyImageSignal(
  scored: ScoredListing,
  listingHash: PHash | null,
  ref: ReferenceSet
): ScoredListing {
  let image: SignalResult;

  if (listingHash === null || ref.hashes.length === 0) {
    image = {
      p: 0,
      raw: {
        status:
          listingHash === null
            ? 'no image evidence (not prioritized within image budget, fetch failed, or unhashable)'
            : 'no reference set',
      },
      unavailable: true,
    };
  } else {
    let best = Infinity;
    let bestRef = '';
    for (const r of ref.hashes) {
      const d = hamming(listingHash, r.hash);
      if (d < best) {
        best = d;
        bestRef = r.name;
      }
    }
    // Map Hamming distance → probability. ≤6: near-exact copy. ≤14: likely
    // same image with edits. ≥26 (~random for 63 bits ≈ 31.5): unrelated.
    const p =
      best <= HAMMING_EXACT ? 1 :
      best <= HAMMING_NEAR ? 0.7 - ((best - HAMMING_EXACT) / (HAMMING_NEAR - HAMMING_EXACT)) * 0.25 :
      best <= 24 ? 0.2 : 0;

    image = {
      p,
      raw: { minHammingDistance: best, closestReference: bestRef },
      reason:
        best <= HAMMING_EXACT
          ? `Listing image is a near-exact perceptual match to authentic photo "${bestRef}" (Hamming ${best}/63)`
          : best <= HAMMING_NEAR
            ? `Listing image is perceptually close to authentic photo "${bestRef}" (Hamming ${best}/63)`
            : undefined,
    };
  }

  const signals = { ...scored.signals, imageSimilarity: image };
  return assemble(scored.listing, signals, false);
}

function assemble(
  listing: Listing,
  signals: Record<string, SignalResult>,
  provisional: boolean
): ScoredListing {
  const weights: Record<string, number> = {
    imageSimilarity: W.image,
    brandAnalysis: W.brand,
    titleSimilarity: W.title,
    priceAnomaly: W.price,
    provenance: W.provenance,
  };

  let probNone = 1;
  for (const [name, sig] of Object.entries(signals)) {
    if (sig.unavailable) continue;
    probNone *= 1 - weights[name] * sig.p;
  }
  let probability = 1 - probNone;

  // Dominant-signal floor
  const img = signals.imageSimilarity;
  const dist = img?.raw?.minHammingDistance;
  if (typeof dist === 'number' && dist <= HAMMING_EXACT) {
    probability = Math.max(probability, FLOOR);
  }

  const reasons = Object.values(signals)
    .filter((s) => s.reason && !s.unavailable)
    .sort((a, b) => b.p - a.p)
    .map((s) => s.reason!) ;

  if (reasons.length === 0) {
    reasons.push('No individual signal fired strongly — low-confidence match on the search query only');
  }
  if (provisional) {
    reasons.push('(provisional: image comparison pending)');
  }

  return {
    listing,
    probability: Math.round(probability * 1000) / 1000,
    reasons,
    signals,
    provisional,
  };
}
