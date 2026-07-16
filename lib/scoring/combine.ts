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

const W = { image: 0.9, brand: 0.8, title: 0.55, price: 0.5 };

const HAMMING_EXACT = 6;   // ≤ this → dominant floor
const HAMMING_NEAR = 14;   // ≤ this → strong-but-not-conclusive image evidence
const FLOOR = 0.88;

export function scoreText(listing: Listing): ScoredListing {
  const title = titleSimilarity(listing.title);
  const brand = brandFuzzy(listing.title);
  const categoryConfirmed = title.p >= 0.25 || brand.p >= 0.45;
  const price = priceAnomaly(listing, categoryConfirmed);

  const signals: Record<string, SignalResult> = {
    imageSimilarity: { p: 0, raw: { status: 'pending' }, unavailable: true },
    brandAnalysis: brand,
    titleSimilarity: title,
    priceAnomaly: price,
  };
  return assemble(listing, signals, true);
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
      raw: { status: listingHash === null ? 'image unavailable or unhashable' : 'no reference set' },
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
