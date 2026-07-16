import { Budget } from '../jobs/budget';
import { Limiter } from '../jobs/limiter';
import type { Platform } from './types';
import { mockSearchResponse } from './mock';

const BASE = 'https://api.scraperapi.com/structured';

// ScraperAPI recommends generous timeouts; their upstream retries can be slow.
const REQUEST_TIMEOUT_MS = 55_000;

export interface SearchPageRequest {
  platform: Platform;
  query: string;
  page: number;
}

/**
 * Single chokepoint for every ScraperAPI call. Concurrency and budget are
 * enforced HERE so no code path can bypass them. Returns the raw parsed JSON
 * body — platform normalizers own interpretation.
 *
 * Throws on: budget denial (BudgetDenied), HTTP failure, timeout.
 */
export class ScraperClient {
  constructor(
    private readonly budget: Budget,
    private readonly limiter: Limiter,
    private readonly apiKey: string,
    private readonly mock: boolean
  ) {}

  async searchPage(req: SearchPageRequest): Promise<unknown> {
    if (!this.budget.canDispatch()) {
      throw new BudgetDenied(this.budget.exhaustionReason() ?? 'time_exhausted');
    }
    return this.limiter.run(async () => {
      // Re-check inside the gate: we may have queued for a while.
      if (!this.budget.canDispatch()) {
        throw new BudgetDenied(this.budget.exhaustionReason() ?? 'time_exhausted');
      }
      this.budget.spend(req.platform);

      if (this.mock) {
        await sleep(400 + Math.random() * 900); // simulate network latency
        return mockSearchResponse(req);
      }

      const url = this.buildUrl(req);
      const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
      if (!res.ok) {
        throw new Error(`ScraperAPI ${req.platform} p${req.page} "${req.query}": HTTP ${res.status}`);
      }
      return res.json();
    });
  }

  private buildUrl({ platform, query, page }: SearchPageRequest): string {
    const q = encodeURIComponent(query);
    if (platform === 'amazon') {
      return `${BASE}/amazon/search/v1?api_key=${this.apiKey}&query=${q}&tld=com&page=${page}`;
    }
    // eBay structured search. NOTE: verified defensively — the normalizer
    // tolerates several plausible response shapes (see ebay.ts).
    return `${BASE}/ebay/search?api_key=${this.apiKey}&query=${q}&tld=com&page_number=${page}`;
  }
}

export class BudgetDenied extends Error {
  constructor(public readonly reason: 'budget_exhausted' | 'time_exhausted') {
    super(`dispatch denied: ${reason}`);
  }
}

export async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
