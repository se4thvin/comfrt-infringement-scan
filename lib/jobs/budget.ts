import type { Platform } from '../scraper/types';

/**
 * Dual budget: a soft request cap on ScraperAPI calls and a wall-clock cap.
 * New work stops being dispatched at T minus DRAIN_WINDOW so in-flight
 * scoring can finish inside the window instead of being killed mid-flight.
 */
export class Budget {
  readonly maxRequests: number;
  readonly maxMs: number;
  private static readonly DRAIN_WINDOW_MS = 30_000;

  readonly startedAt = Date.now();
  counts: Record<Platform, number> = { amazon: 0, ebay: 0 };
  imageFetches = 0;

  constructor(maxRequests = 120, maxMs = 4 * 60_000) {
    this.maxRequests = maxRequests;
    this.maxMs = maxMs;
  }

  get used(): number {
    return this.counts.amazon + this.counts.ebay;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** May we start NEW ScraperAPI work? (false inside the drain window) */
  canDispatch(): boolean {
    return (
      this.used < this.maxRequests &&
      this.elapsedMs < this.maxMs - Budget.DRAIN_WINDOW_MS
    );
  }

  /** May we start a new direct image fetch? Cheaper gate: images don't spend
   *  ScraperAPI budget, but they must still respect the wall clock. */
  canFetchImage(maxImages: number): boolean {
    return this.imageFetches < maxImages && this.elapsedMs < this.maxMs - 10_000;
  }

  spend(platform: Platform): void {
    this.counts[platform]++;
  }

  spendImage(): void {
    this.imageFetches++;
  }

  exhaustionReason(): 'budget_exhausted' | 'time_exhausted' | null {
    if (this.used >= this.maxRequests) return 'budget_exhausted';
    if (this.elapsedMs >= this.maxMs - Budget.DRAIN_WINDOW_MS) return 'time_exhausted';
    return null;
  }
}
