import { EventEmitter } from 'node:events';
import type { JobEvent, ScoredListing, JobStats, DoneReason } from '../scraper/types';

/* Jobs live in a module-level Map and publish events through an emitter.
 * The SSE endpoint SUBSCRIBES to a job rather than owning it — a client
 * refresh reconnects and replays state instead of killing the job.
 *
 * Stated limitation: this assumes one long-lived Node process (`next dev` /
 * `next start`). Serverless would need external state — see ARCHITECTURE.md.
 *
 * globalThis anchoring: in dev, Next.js can re-evaluate modules on HMR; the
 * store must survive that. */

export interface JobState {
  id: string;
  createdAt: number;
  results: Map<string, ScoredListing>;
  stats: JobStats | null;
  warnings: string[];
  done: { reason: DoneReason; message?: string } | null;
  emitter: EventEmitter;
}

const TTL_MS = 30 * 60_000;

const g = globalThis as unknown as { __jobStore?: Map<string, JobState> };
const store: Map<string, JobState> = g.__jobStore ?? new Map();
g.__jobStore = store;

export function createJob(): JobState {
  sweep();
  const id = Math.random().toString(36).slice(2, 10);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const job: JobState = {
    id,
    createdAt: Date.now(),
    results: new Map(),
    stats: null,
    warnings: [],
    done: null,
    emitter,
  };
  store.set(id, job);
  return job;
}

export function getJob(id: string): JobState | undefined {
  return store.get(id);
}

/** Publish an event: update materialized state (for replay) then notify
 *  live subscribers. */
export function publish(job: JobState, event: JobEvent): void {
  switch (event.type) {
    case 'listing':
      job.results.set(event.data.listing.key, event.data);
      break;
    case 'stats':
      job.stats = event.data;
      break;
    case 'warning':
      job.warnings.push(event.data.message);
      break;
    case 'done':
      job.done = event.data;
      break;
  }
  job.emitter.emit('event', event);
}

/** Everything a late subscriber needs to catch up. */
export function snapshot(job: JobState): JobEvent[] {
  const events: JobEvent[] = [];
  for (const w of job.warnings) events.push({ type: 'warning', data: { message: w } });
  for (const r of job.results.values()) events.push({ type: 'listing', data: r });
  if (job.stats) events.push({ type: 'stats', data: job.stats });
  if (job.done) events.push({ type: 'done', data: job.done });
  return events;
}

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of store) {
    if (now - job.createdAt > TTL_MS) store.delete(id);
  }
}
