import { Budget } from './budget';
import { Limiter } from './limiter';
import { publish, type JobState } from './store';
import { ScraperClient, BudgetDenied, fetchWithTimeout } from '../scraper/client';
import { normalizeAmazon } from '../scraper/amazon';
import { normalizeEbay, parseEbayHtml, structuredCameBackEmpty } from '../scraper/ebay';
import type { Listing, Platform, DoneReason } from '../scraper/types';
import { scoreText, applyImageSignal } from '../scoring/combine';
import { prepareReferenceSet } from '../reference/prepare';
import { phashFromBuffer } from '../scoring/signals/imageHash';

/* Pipeline shape (the reasoning, condensed):
 *
 *   search pages ──► normalize ──► dedupe ──► TEXT score ──► emit provisional
 *                                                 │
 *                                    (sorted by provisional score)
 *                                                 ▼
 *                                     image fetch + pHash ──► emit final
 *
 * Text signals are free (no requests), so every listing gets a provisional
 * score within seconds of its search page landing. The image budget is then
 * spent on candidates in provisional-score order — the expensive signal goes
 * where it changes the ranking most. Image failure = listing keeps its
 * provisional score, flagged; degradation is the default path, not a
 * try/catch bolt-on. */

// Brand + category terms, plus the two most distinctive live product lines
// (verified against comfrt.com's catalog 2026-07 — earlier drafts searched
// product names the brand doesn't actually sell).
const QUERIES = [
  'comfrt hoodie',
  'comfrt sweatshirt',
  'comfrt oversized hoodie',
  'comfrt minimalist hoodie',
  'comfrt quarter zip',
  'comfrt sweatpants',
];
const PAGES_PER_QUERY = 2;
const PLATFORMS: Platform[] = ['amazon', 'ebay'];

const SCRAPER_CONCURRENCY = 6;
const IMAGE_CONCURRENCY = 8;
const MAX_IMAGE_FETCHES = 60;
const IMAGE_SCORE_FLOOR = 0.15; // don't spend image fetches on obvious noise
const IMAGE_FETCH_TIMEOUT_MS = 12_000;
const MOCK_TIME_BUDGET_MS = 45_000; // keep mock runs snappy

export async function runJob(job: JobState): Promise<void> {
  const mock = process.env.MOCK_MODE === '1';
  const apiKey = process.env.SCRAPERAPI_KEY ?? '';
  const budget = new Budget(120, mock ? MOCK_TIME_BUDGET_MS : 4 * 60_000);
  const scraperLimiter = new Limiter(SCRAPER_CONCURRENCY);
  const imageLimiter = new Limiter(IMAGE_CONCURRENCY);
  const client = new ScraperClient(budget, scraperLimiter, apiKey, mock);

  const seen = new Set<string>();
  const scored = new Map<string, ReturnType<typeof scoreText>>();
  let denialReason: DoneReason | null = null;

  let currentPhase: 'searching' | 'imaging' | 'done' = 'searching';
  const statsTimer = setInterval(() => emitStats(currentPhase), 1000);

  function emitStats(phase: 'searching' | 'imaging' | 'done') {
    currentPhase = phase;
    publish(job, {
      type: 'stats',
      data: {
        startedAt: budget.startedAt,
        elapsedMs: budget.elapsedMs,
        requests: { ...budget.counts, images: budget.imageFetches },
        budget: { max: budget.maxRequests, used: budget.used },
        listingsSeen: seen.size,
        listingsScored: scored.size,
        phase,
      },
    });
  }

  try {
    if (!mock && !apiKey) {
      publish(job, {
        type: 'done',
        data: { reason: 'error', message: 'SCRAPERAPI_KEY missing. Set it in .env.local, or set MOCK_MODE=1.' },
      });
      return;
    }

    const ref = await prepareReferenceSet(mock);
    if (ref.warning) publish(job, { type: 'warning', data: { message: ref.warning } });

    // ---- Phase 1: search fan-out.
    // Page 1 of every (platform, query) first, then page 2s — breadth beats
    // depth when the budget might run out mid-flight.
    const pageJobs: Array<{ platform: Platform; query: string; page: number }> = [];
    for (let page = 1; page <= PAGES_PER_QUERY; page++)
      for (const platform of PLATFORMS)
        for (const query of QUERIES) pageJobs.push({ platform, query, page });

    // ScraperAPI's structured eBay extractor currently returns empty objects
    // for exactly our query class (see ebay.ts). Adaptive per job: when a page
    // hits the trap, the job flips to HTML mode (+1 request for that page);
    // later pages skip structured entirely. Self-heals to zero-cost when
    // ScraperAPI fixes their extractor.
    let ebayHtmlMode = false;

    const processPage = async (pj: { platform: Platform; query: string; page: number }) => {
      try {
        let listings;
        if (pj.platform === 'amazon') {
          listings = normalizeAmazon(await client.searchPage(pj), pj.query);
        } else if (ebayHtmlMode) {
          listings = parseEbayHtml(await client.ebaySearchHtml(pj), pj.query);
        } else {
          const raw = await client.searchPage(pj);
          if (structuredCameBackEmpty(raw)) {
            ebayHtmlMode = true;
            publish(job, {
              type: 'warning',
              data: {
                message: `eBay structured API returned field-less items for "${pj.query}" p${pj.page} — switching this job to HTML parsing`,
              },
            });
            listings = parseEbayHtml(await client.ebaySearchHtml(pj), pj.query);
          } else {
            listings = normalizeEbay(raw, pj.query);
          }
        }
        for (const listing of listings) {
          if (seen.has(listing.key)) continue; // dedupe by platform:id
          seen.add(listing.key);
          const s = scoreText(listing);
          scored.set(listing.key, s);
          publish(job, { type: 'listing', data: s });
        }
      } catch (e) {
        if (e instanceof BudgetDenied) {
          denialReason = e.reason;
          return; // expected under budget pressure — not an error
        }
        publish(job, {
          type: 'warning',
          data: { message: `${pj.platform} "${pj.query}" p${pj.page} failed: ${(e as Error).message}` },
        });
      }
    };

    // Probe eBay once BEFORE the fan-out. Concurrent page-1 dispatch would
    // otherwise have every eBay request discover the structured-endpoint trap
    // independently — ~6 wasted requests per job. One sequenced round-trip
    // sets the mode for everyone; its results are used, so a healthy endpoint
    // costs nothing extra.
    const probeIdx = pageJobs.findIndex((p) => p.platform === 'ebay');
    if (probeIdx >= 0) {
      const [probe] = pageJobs.splice(probeIdx, 1);
      await processPage(probe);
    }
    await Promise.all(pageJobs.map(processPage));

    // ---- Phase 2: image evidence, best provisional candidates first.
    emitStats('imaging');
    const candidates = [...scored.values()]
      .filter((s) => s.listing.imageUrl && s.probability >= IMAGE_SCORE_FLOOR)
      .sort((a, b) => b.probability - a.probability);

    await Promise.all(
      candidates.map((cand) =>
        imageLimiter.run(async () => {
          if (!budget.canFetchImage(MAX_IMAGE_FETCHES)) return; // keeps provisional score
          budget.spendImage();
          let hash = null;
          try {
            const res = await fetchWithTimeout(cand.listing.imageUrl!, IMAGE_FETCH_TIMEOUT_MS);
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              hash = await phashFromBuffer(buf);
            }
          } catch {
            /* hash stays null → signal reports unavailable */
          }
          const updated = applyImageSignal(cand, hash, ref);
          scored.set(updated.listing.key, updated);
          publish(job, { type: 'listing', data: updated });
        })
      )
    );

    // Listings never imaged (below floor / budget ran dry): finalize them so
    // nothing is left marked "pending" forever.
    for (const [key, s] of scored) {
      if (s.provisional) {
        const finalized = applyImageSignal(s, null, ref);
        scored.set(key, finalized);
        publish(job, { type: 'listing', data: finalized });
      }
    }

    const reason: DoneReason = denialReason ?? budget.exhaustionReason() ?? 'complete';
    emitStats('done'); // final stats must precede 'done' — clients close on 'done'
    publish(job, { type: 'done', data: { reason } });
  } catch (e) {
    emitStats('done');
    publish(job, { type: 'done', data: { reason: 'error', message: (e as Error).message } });
  } finally {
    clearInterval(statsTimer);
  }
}
