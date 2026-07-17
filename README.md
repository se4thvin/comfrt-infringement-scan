# Comfrt Infringement Scan

Simulates a simplified infringement-detection pipeline: triggers a search job
across Amazon + eBay (via ScraperAPI), scores every deduped listing with four
independent signals (plus a contextual fifth), and streams a ranked,
explainable result list to the UI as evidence arrives.

## Run it

Requires Node 18.17+ (20 recommended). No other setup — the reference images
are committed and `sharp` installs prebuilt binaries.

```bash
npm install
cp .env.example .env.local        # ScraperAPI key, pre-filled from the brief
npm run dev                       # open http://localhost:3000 and hit "Run scan"
```

**What a live scan looks like:** first provisional results appear within
~15 seconds; the run typically completes in 30s–2min (hard ceiling 4min).
One scan makes ~24–30 ScraperAPI requests against the ~120 soft budget —
the UI shows the count per platform live. Warnings like *"eBay structured
API returned field-less items … switching to HTML parsing"* are the
pipeline's fallback working as designed, not an error (see Known
limitations). Expand any result row to see why it scored what it did.

**No key / no network?** `MOCK_MODE=1 npm run dev` runs the identical
pipeline against 21 fixture listings covering the archetypes the scorer must
separate (stolen photos, homoglyph brands, evasion language, unrelated
noise), scoring images against the committed reference set — every code path
except the literal ScraperAPI HTTP call is exercised, ~5s per run, zero
external calls.

The 8 authentic reference images live in `lib/reference/images/`, so scoring
has zero runtime dependency on comfrt.com. To refresh them against the live
catalog: `npm run fetch-reference` (Shopify's public `/products.json`;
flagship handles pinned in `scripts/fetch-reference.mjs`, mirrored by
`REFERENCE_TITLES`).

## How it works

```
search fan-out ──► normalize ──► dedupe ──► TEXT score ──► emit provisional ──► UI
 (Amazon+eBay,      (defensive     (by                          │
  6 queries ×        per-platform   platform:id)   sorted by provisional score
  2 pages)           normalizers)                               ▼
                                                   image fetch + pHash ──► emit final ──► UI
```

- **Text signals are free** (no external requests), so every listing gets a
  provisional score seconds after its search page lands — first results are
  on screen in ~15s, not after 4 minutes.
- **The image budget is spent best-candidates-first**: listings are imaged in
  provisional-score order, so the expensive signal goes where it changes the
  ranking most.
- **Degradation is the default path, not a try/catch bolt-on**: a failed image
  fetch just means the listing keeps its text-only score, with the image
  signal marked unavailable in the inspection panel.

### The four signals

| signal | what it measures | max contribution |
|---|---|---|
| `imageSimilarity` | pHash (32×32 DCT) Hamming distance to the 8 reference images | 0.9 |
| `brandAnalysis` | exact "comfrt" / near-miss spellings / homoglyphs (Cømfrt, C0MFRT) / evasion phrases ("dupe", "replica", "same factory") | 0.8 |
| `titleSimilarity` | token Jaccard + bigram containment vs canonical product names (brand token excluded — no double counting) | 0.55 |
| `priceAnomaly` | distance below the authentic retail floor; **gated** on category confirmation, **halved** for eBay auctions and used-condition listings | 0.5 |
| `provenance` *(contextual 5th)* | where the goods come from: new brand-related items shipping from outside the US; template-titled batch inventory (one seller, many variants — manufacturer depth, not a closet cleanout) | 0.4 |

### Combination: noisy-OR + dominant-signal floor

`P = 1 − ∏(1 − wᵢ·pᵢ)` — independent-ish evidence compounds upward. A
weighted *mean* would let a stolen product photo be averaged down by a
rewritten title, which is exactly the wrong ranking for the most damning
case. Additionally, a near-exact image match (Hamming ≤ 6/63) floors the
score at 0.88 on its own: sufficient evidence needs no corroboration.

One interaction rule, added after manually ground-truthing a live scan's top
results against the real listings: **brand mention + no product-title match +
not used-condition ⇒ keyword squatting** (brand signal escalates to 0.7).
The live scan's genuinely-infringing listing — a $9.99 "Generic" hoodie dress
stuffing "Comfrt Pullover" into its title — was outranked by five legal
second-hand resales before this rule; after it, squatters rank first. Used
listings are exempt: squatting is a new-goods game, and resellers describe
authentic items generically ("Men's XL Gray Pullover Hoodie") without naming
the product line.

**Honesty notes:** scores are a monotonic ranking heuristic mapped to [0,1],
not calibrated probabilities — calibration would need labeled takedown
outcomes. The price signal is deliberately *not* independent of the text
signals (it's gated on them) because the ungated version false-positives on
cheap unrelated items and eBay auctions; the dependency is the lesser evil.

## Live validation: what checking the top results against reality taught us

After the first live scan, the top-ranked listings were manually verified
against the actual marketplace pages (seller profiles, condition, photos,
official colorways and prices from comfrt.com's catalog). Findings:

- **The top eBay results were authentic second-hand resales**, not
  counterfeits — e.g. rank #1 was a pre-owned hoodie from a 16K-feedback
  thrift reseller. Every "suspicious" colorway was a real official colorway;
  every "suspicious" price was an ordinary used-market price.
- **The one genuinely infringing listing ranked #7**: a $9.99 Brand-"Generic"
  hoodie dress stuffing "Comfrt Pullover" into its title and "comfrt travel
  hoodie" into its hidden keywords — textbook trademark keyword-squatting.
- **The structural lesson:** brand-mention and title-similarity measure *"is
  this about Comfrt?"*, not *"is this fraudulent?"*. On eBay the most
  brand-related listings are legal first-sale resales, so relatedness signals
  alone fill the top ranks with the benign class. The evidence that actually
  separates counterfeit from resale was never in the title: condition, seller
  shape, brand-vs-title mismatch, provenance.

Three scoring changes came directly out of that ground-truthing — the
keyword-squat rule, used-condition awareness, and the provenance signal (all
described above). Re-scoring the same scan afterwards put the keyword-squatters
at #1–2 and compressed the resales.

**The roadmap this implies** (out of scope here, sketched in
[ARCHITECTURE.md](./ARCHITECTURE.md)): score sellers, not just listings
(account age, inventory depth, specialization); classify the *violation type*
(keyword-squat vs stolen-photo vs suspected-fake — different evidence,
different takedown paths); and above all close the labeling loop — human
review of the top-K feeds labels back into the weights, making "accurate"
a measurable precision@K instead of a hope. Test purchases remain the only
gold labels for physical fakes.

### Orchestration constraints

- Concurrency: 6 in-flight ScraperAPI calls, 8 in-flight image fetches, each
  through a semaphore in the single client chokepoint — no code path can
  bypass it.
- Dual budget: 120 ScraperAPI requests **and** a 4-minute wall clock, with a
  30s drain window (no new dispatch near the deadline; in-flight work
  finishes). Direct CDN image fetches don't spend ScraperAPI budget but are
  counted and shown separately in the UI — "requests" reporting stays honest.
- Jobs are decoupled from HTTP: state lives in an in-memory store; the SSE
  endpoint is a *subscriber* that replays on (re)connect. Refreshing the page
  mid-job wastes nothing.

## Known limitations (deliberate)

- **In-memory job store** assumes one long-lived Node process (`next dev` /
  `next start`). Serverless deployment would need external state — that
  migration is the subject of [ARCHITECTURE.md](./ARCHITECTURE.md).
- **pHash matches copied photos, not similar products.** A counterfeiter who
  reshoots their own product photos evades it; the upgrade path is a CLIP-style
  embedding signal, which slots in as a fifth signal without touching the
  combiner.
- **eBay's structured endpoint is a per-request coin flip** (found during live
  validation): when eBay serves its new `s-card` markup, ScraperAPI's extractor
  returns the correct item *count* but every object empty — an endpoint that
  looks healthy until you send it a niche query. The pipeline probes eBay once
  before the fan-out and adaptively switches the job to fetching raw HTML
  (through the same budget chokepoint) parsed by our own `s-card` parser; it
  self-heals to zero extra cost if ScraperAPI fixes their extractor. The
  parser is regex-over-stable-anchors by choice (`data-listingid`, `/itm/<id>`,
  `s-card__price`) — dependency-light, loud when it parses nothing.
- **eBay sponsored labels are not detectable** in the new markup: every card
  contains a transparent `derosnopS` decoy and the real label is homoglyph text
  inside a base64 SVG. We report `sponsored` as unknown rather than guess.
- Same counterfeit listed by multiple sellers intentionally appears as
  multiple results — each listing is a separate takedown target.
- **A live scan's top eBay results are dominated by second-hand resales** of
  authentic Comfrt garments — brand + title match, seller-taken photos
  (pHash distances 18+, correctly no near-exact match), plausible used prices.
  Distinguishing legal resale from counterfeiting needs evidence outside a
  search page (seller history, image forensics); the scorer makes this visible
  in its reasons rather than pretending to resolve it.
