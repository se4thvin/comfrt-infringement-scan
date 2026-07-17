export type Platform = 'amazon' | 'ebay';

/** Normalized shape both marketplaces map into. Everything downstream of the
 *  normalizers speaks only this type. */
export interface Listing {
  /** `${platform}:${id}` — dedupe key. Platforms have separate id namespaces. */
  key: string;
  platform: Platform;
  id: string; // ASIN or eBay item id
  title: string;
  url: string;
  imageUrl?: string;
  price?: number; // numeric, in listing currency (assumed USD for .com/US)
  priceString?: string;
  sponsored?: boolean;
  /** eBay: 'auction' listings get a down-weighted price signal */
  listingType?: 'auction' | 'fixed' | 'unknown';
  /** eBay: 'used' is structural evidence of second-hand resale (halves the
   *  price signal, like auctions) — counterfeiters overwhelmingly sell "new" */
  condition?: 'new' | 'used' | 'unknown';
  sourceQuery: string;
}

export interface SignalResult {
  /** calibrated-ish probability contribution in [0,1] */
  p: number;
  /** raw value(s) for the inspection panel */
  raw: Record<string, number | string | null>;
  /** human-readable reason, present only when the signal meaningfully fired */
  reason?: string;
  /** signal could not run (e.g. no image) — distinct from "ran and found nothing" */
  unavailable?: boolean;
}

export interface ScoredListing {
  listing: Listing;
  probability: number;
  reasons: string[];
  signals: Record<string, SignalResult>;
  /** true until the image signal has resolved (or been skipped) */
  provisional: boolean;
}

export interface JobStats {
  startedAt: number;
  elapsedMs: number;
  requests: {
    amazon: number;
    ebay: number;
    /** direct CDN image fetches — external calls, honestly counted, but not
     *  spent from the ScraperAPI budget */
    images: number;
  };
  budget: { max: number; used: number };
  listingsSeen: number;
  listingsScored: number;
  phase: 'searching' | 'imaging' | 'done';
}

export type DoneReason = 'complete' | 'budget_exhausted' | 'time_exhausted' | 'error';

export type JobEvent =
  | { type: 'listing'; data: ScoredListing }
  | { type: 'stats'; data: JobStats }
  | { type: 'warning'; data: { message: string } }
  | { type: 'done'; data: { reason: DoneReason; message?: string } };
