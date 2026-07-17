# Evolving to multi-tenant: hundreds of clients

The demo was deliberately built along the seams this migration splits: the
scraper chokepoint becomes a rate-limited fetch service, the inline job
runner becomes queue consumers, and SSE-over-request becomes SSE-over-pubsub.
The UI and scoring code are unchanged.

## Job orchestration

**API tier** accepts `POST /jobs`, writes a job row, and enqueues a
`job.plan` message. **Workers** consume from queues (SQS/RabbitMQ; Redis
Streams is fine at this scale) in three stages, mirroring the demo's phases:

1. `plan` → expand a client's brand config (queries, marketplaces, reference
   set version) into page-fetch tasks.
2. `fetch` → one task per (platform, query, page): call ScraperAPI, normalize,
   dedupe against the job's seen-set (Redis SET), write listings, text-score
   them immediately (cheap, in-process), enqueue image tasks for candidates
   above the floor.
3. `image` → fetch image → pHash/embed → final score → write result, publish
   `result.updated` to the job's pub/sub channel.

Stages scale independently — image workers are the bottleneck and get the
biggest pool. Fan-out/fan-in state (pages remaining, images remaining) lives
in Redis counters; when both hit zero the job is marked done.

## Rate limiting & per-client isolation

- **Global ScraperAPI limiter**: distributed token bucket (Redis) sized to the
  account's concurrency plan — the demo's semaphore, made shared.
- **Per-client budgets**: each job carries `max_requests` / `max_seconds` from
  the client's plan; workers check-and-decrement atomically before dispatch
  (the demo's `Budget.canDispatch()`, moved to Redis).
- **Fairness**: weighted round-robin across per-client queues (or one queue
  with per-client concurrency caps) so one client's 50k-listing scan can't
  starve everyone else. Noisy-neighbor image workloads are contained the same
  way.
- Marketplace credentials/proxies per client where clients bring their own.

## Data model

- **Postgres**: `clients`, `brand_configs` (queries, price bands, reference
  set version), `jobs` (status, budgets, counters, done_reason), `listings`
  (platform, external_id, title, price, url — unique on platform+external_id
  per client), `scores` (job_id, listing_id, probability, per-signal raw
  JSONB, reasons). Keeping raw signal values is what makes historical scores
  re-explainable after weight changes.
- **Object storage (S3)**: reference images, fetched listing images, and raw
  scraper responses (short TTL) — replayable without re-spending budget.
- **Redis**: job progress counters, dedupe sets, rate-limit buckets, pub/sub
  for live result streams.
- Reference sets are **versioned**; scores record which version scored them.

## Retries & failure handling

- Fetch tasks: exponential backoff + jitter, ≤3 attempts, then dead-letter
  with the raw error; a page's failure never fails the job (breadth-first
  dispatch means partial coverage is still useful — same as the demo).
- Image tasks: 1 retry then score-without-image (the demo's degradation
  path, unchanged).
- Worker crash: queue visibility timeout re-delivers; tasks are idempotent
  (dedupe set + upsert-by-key makes re-processing harmless).
- Job-level watchdog: any job past `max_seconds × 1.5` is force-finalized
  with `time_exhausted` so nothing hangs in "running" forever.

## Observability

- **Per-job**: elapsed, requests by platform, budget consumption %, listings
  seen/scored/imaged, done reason distribution.
- **Pipeline health**: queue depth & oldest-message age per stage (the paging
  signal), task retry/DLQ rates, ScraperAPI error rates + p95 latency by
  platform (their instability is our primary external risk), image fetch
  success rate by CDN.
- **Scoring quality**: score distribution per client over time (a sudden
  shift usually means a marketplace changed response shape — pair with a
  normalizer "zero results" alert), % of results where each signal was
  unavailable, and takedown-outcome feedback where clients report it — the
  eventual labeled data that turns heuristic weights into a calibrated model.
- Structured logs keyed by `client_id / job_id / task_id`; traces across
  stage boundaries.

## Closing the accuracy loop

Live validation of this demo showed the core precision problem: relatedness
signals (brand, title) rank legal second-hand resales alongside true
infringement. At scale the fix is a feedback loop, not more heuristics:
score → human review queue (sorted by score, per client) → reviewer labels
(counterfeit / resale / keyword-squat / benign) → labels retrain the signal
weights (logistic regression over the existing raw values keeps every score
explainable) → measure **precision@K**, since reviewer time is the scarce
resource. Seller-level features (account age, inventory depth, listing-title
templates — the strongest separators found during validation) become
first-class once results are stored per seller, and violation *type*
classification routes each finding to the right takedown path.
