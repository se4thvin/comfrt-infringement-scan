import { BRAND } from '../../reference/products';
import type { SignalResult } from '../../scraper/types';

/* Brand analysis over the listing title. Three tiers, in descending
 * suspicion:
 *
 *  1. EVASION patterns — "comfrt style", "comfrt dupe", "comfrt replica",
 *     homoglyphs (ø, 0). These are stronger evidence than a clean brand
 *     mention: sellers write them precisely to trade on the brand while
 *     dodging keyword takedowns.
 *  2. NEAR-MISS — edit distance 1–2 from "comfrt" ("comfrtt", "comftr").
 *  3. EXACT mention — consistent with counterfeiting AND with authorized
 *     resale, so it contributes real but bounded probability.
 *
 * "comfy"/"comfort" are NOT near-misses: ordinary English words, distance 2+
 * with high prior legitimate use. The token must not be a dictionary comfort
 * word to count as a near-miss. */

const EVASION_WORDS = ['dupe', 'replica', 'style', 'inspired', 'same factory', 'oem', 'unbranded', 'like comfrt'];
const HOMOGLYPHS: Record<string, string> = { 'ø': 'o', '0': 'o', 'о': 'o', 'ɱ': 'm', 'ѕ': 's', '@': 'a' };
const DICTIONARY_EXCLUDE = new Set(['comfy', 'comfort', 'comfortable', 'comforts', 'comfier']);

export function brandFuzzy(title: string): SignalResult {
  const lower = title.toLowerCase();
  const deglyphed = [...lower].map((c) => HOMOGLYPHS[c] ?? c).join('');
  const words = deglyphed.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  const exact = words.includes(BRAND);
  const usedHomoglyph = exact && !lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).includes(BRAND);

  let nearMiss: string | null = null;
  if (!exact) {
    for (const w of words) {
      if (DICTIONARY_EXCLUDE.has(w)) continue;
      if (Math.abs(w.length - BRAND.length) > 2) continue;
      const d = levenshtein(w, BRAND);
      if (d > 0 && d <= 2) {
        nearMiss = w;
        break;
      }
    }
  }

  const evasion = (exact || nearMiss) ? EVASION_WORDS.find((e) => deglyphed.includes(e)) ?? null : null;

  let p = 0;
  let reason: string | undefined;
  if (usedHomoglyph) {
    p = 0.85;
    reason = `Brand written with lookalike characters to evade keyword filters`;
  } else if (evasion) {
    p = 0.8;
    reason = `Brand mention combined with evasion language ("${evasion}")`;
  } else if (nearMiss) {
    p = 0.65;
    reason = `Near-miss brand spelling "${nearMiss}" (edit distance ${levenshtein(nearMiss, BRAND)} from "${BRAND}")`;
  } else if (exact) {
    p = 0.45;
    reason = `Title uses the brand name "comfrt" verbatim`;
  }

  return {
    p,
    raw: {
      exactMention: exact ? 1 : 0,
      homoglyph: usedHomoglyph ? 1 : 0,
      nearMissToken: nearMiss,
      evasionPhrase: evasion,
    },
    reason,
  };
}

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return dp[m][n];
}
