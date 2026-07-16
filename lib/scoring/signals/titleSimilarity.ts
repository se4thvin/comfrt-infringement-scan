import { REFERENCE_TITLES } from '../../reference/products';
import type { SignalResult } from '../../scraper/types';

/* Token-level similarity against the canonical product names. Two components:
 *  - Jaccard over word tokens (order-free)
 *  - fraction of reference bigrams contained in the listing title
 *    (rewards intact phrases like "cloud hoodie")
 * Best match across the reference titles wins. Brand token is stripped first;
 * brand matching is its own signal and must not be double counted here. */

const STOP = new Set(['the', 'a', 'an', 'for', 'with', 'and', 'or', 'of', 'in', 'to']);

export function titleSimilarity(title: string): SignalResult {
  const listingTokens = tokens(title);
  let best = 0;
  let bestRef = '';

  for (const ref of REFERENCE_TITLES) {
    const refTokens = tokens(ref);
    if (refTokens.length === 0) continue;

    const setL = new Set(listingTokens);
    const setR = new Set(refTokens);
    const inter = [...setR].filter((t) => setL.has(t)).length;
    const union = new Set([...setL, ...setR]).size;
    const jaccard = union === 0 ? 0 : inter / union;

    const refBigrams = bigrams(refTokens);
    const listBigrams = new Set(bigrams(listingTokens));
    const bigramHit =
      refBigrams.length === 0
        ? 0
        : refBigrams.filter((b) => listBigrams.has(b)).length / refBigrams.length;

    const s = 0.5 * jaccard + 0.5 * bigramHit;
    if (s > best) {
      best = s;
      bestRef = ref;
    }
  }

  // Map similarity → probability contribution. Titles legitimately share
  // generic words ("oversized hoodie"), so this signal saturates modestly:
  // it corroborates, it does not convict.
  const p = clamp01(best * 0.9);
  return {
    p,
    raw: { bestSimilarity: round(best), bestReferenceTitle: bestRef || null },
    reason:
      best >= 0.45
        ? `Title closely mirrors authentic product "${bestRef}" (similarity ${round(best)})`
        : undefined,
  };
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t) && t !== 'comfrt'); // brand handled separately
}
function bigrams(t: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(`${t[i]} ${t[i + 1]}`);
  return out;
}
export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const round = (x: number) => Math.round(x * 1000) / 1000;
