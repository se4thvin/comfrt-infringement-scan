'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobEvent, JobStats, ScoredListing, DoneReason, SignalResult } from '@/lib/scraper/types';

type SortKey = 'score' | 'price';

const SIGNAL_LABELS: Record<string, string> = {
  imageSimilarity: 'Image similarity',
  brandAnalysis: 'Brand analysis',
  titleSimilarity: 'Title similarity',
  priceAnomaly: 'Price anomaly',
  provenance: 'Provenance',
};

export default function Page() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [results, setResults] = useState<Map<string, ScoredListing>>(new Map());
  const [stats, setStats] = useState<JobStats | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [done, setDone] = useState<{ reason: DoneReason; message?: string } | null>(null);
  const [running, setRunning] = useState(false);

  // filters / sort
  const [minScore, setMinScore] = useState(0.3);
  const [platforms, setPlatforms] = useState({ amazon: true, ebay: true });
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [expanded, setExpanded] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);

  const start = useCallback(async () => {
    esRef.current?.close();
    setResults(new Map());
    setStats(null);
    setWarnings([]);
    setDone(null);
    setRunning(true);

    const res = await fetch('/api/jobs', { method: 'POST' });
    if (!res.ok) {
      setWarnings([`The scan couldn't start (HTTP ${res.status}). Check that the dev server is running and try again.`]);
      setRunning(false);
      return;
    }
    const { jobId } = await res.json();
    setJobId(jobId);
  }, []);

  // Subscribe (and resubscribe on transient drops — EventSource auto-retries;
  // the server replays state so reconnects are lossless).
  useEffect(() => {
    if (!jobId) return;
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as JobEvent;
      switch (ev.type) {
        case 'listing':
          setResults((prev) => {
            const next = new Map(prev);
            next.set(ev.data.listing.key, ev.data);
            return next;
          });
          break;
        case 'stats':
          setStats(ev.data);
          break;
        case 'warning':
          setWarnings((w) => (w.includes(ev.data.message) ? w : [...w, ev.data.message]));
          break;
        case 'done':
          setDone(ev.data);
          setRunning(false);
          es.close();
          break;
      }
    };
    es.onerror = () => {
      // auto-reconnect is built into EventSource; only surface if job is gone
    };
    return () => es.close();
  }, [jobId]);

  const visible = useMemo(() => {
    const arr = [...results.values()].filter(
      (r) => r.probability >= minScore && platforms[r.listing.platform]
    );
    arr.sort((a, b) =>
      sortKey === 'score'
        ? b.probability - a.probability
        : (a.listing.price ?? Infinity) - (b.listing.price ?? Infinity)
    );
    return arr;
  }, [results, minScore, platforms, sortKey]);

  const total = results.size;

  return (
    <>
      <header className="toolbar">
        <div className="toolbar-inner">
          <span className="brand">Comfrt Scan</span>
          <StatusLine running={running} stats={stats} done={done} total={total} />
          <button className="primary" onClick={start} disabled={running}>
            {running ? 'Scanning…' : total > 0 ? 'Scan again' : 'Run scan'}
          </button>
        </div>
      </header>

    <main>
      <div className="hero">
        <h1>Infringement scan</h1>
        <p className="caption">
          Searches Amazon and eBay for likely counterfeit Comfrt listings and ranks
          them by evidence, as results stream in.
        </p>
      </div>

      {stats && (
        <div className="statsbar">
          <div className="stat">
            <div className="v">{fmtMs(stats.elapsedMs)}</div>
            <div className="k">Elapsed</div>
          </div>
          <div className="stat">
            <div className="v">
              {stats.budget.used}<small>/ {stats.budget.max}</small>
            </div>
            <div className="k">Request budget</div>
          </div>
          <div className="stat">
            <div className="v">{stats.requests.amazon}</div>
            <div className="k">Amazon requests</div>
          </div>
          <div className="stat">
            <div className="v">{stats.requests.ebay}</div>
            <div className="k">eBay requests</div>
          </div>
          <div className="stat">
            <div className="v">{stats.requests.images}</div>
            <div className="k">Images compared</div>
          </div>
          <div className="stat">
            <div className="v">{stats.listingsSeen}</div>
            <div className="k">Unique listings</div>
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="warnings">
          {warnings.map((w, i) => (
            <div className="warn" key={i}>{w}</div>
          ))}
        </div>
      )}

      {total > 0 && (
        <div className="filters">
          <label>
            Min score
            <input
              type="range" min={0} max={0.9} step={0.05} value={minScore}
              onChange={(e) => setMinScore(parseFloat(e.target.value))}
            />
            <span className="thresh">{minScore.toFixed(2)}</span>
          </label>
          <label className={`chip ${platforms.amazon ? 'on' : ''}`}>
            <input
              type="checkbox" checked={platforms.amazon}
              onChange={(e) => setPlatforms((p) => ({ ...p, amazon: e.target.checked }))}
            />
            Amazon
          </label>
          <label className={`chip ${platforms.ebay ? 'on' : ''}`}>
            <input
              type="checkbox" checked={platforms.ebay}
              onChange={(e) => setPlatforms((p) => ({ ...p, ebay: e.target.checked }))}
            />
            eBay
          </label>
          <label>
            Sort
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="score">Highest score</option>
              <option value="price">Lowest price</option>
            </select>
          </label>
          <span className="count">{visible.length} of {total}</span>
        </div>
      )}

      <div className="results">
        {visible.map((r) => (
          <ResultRow
            key={r.listing.key}
            r={r}
            open={expanded === r.listing.key}
            onToggle={() =>
              setExpanded((cur) => (cur === r.listing.key ? null : r.listing.key))
            }
          />
        ))}
      </div>

      {total === 0 && !running && (
        <div className="empty-state">
          Run scan searches both marketplaces, scores every listing against the
          authentic Comfrt reference set, and streams results here as evidence
          arrives.
        </div>
      )}
      {total > 0 && visible.length === 0 && (
        <div className="empty-state">
          Nothing above the current score threshold. Lower it to see more results.
        </div>
      )}
    </main>
    </>
  );
}

function StatusLine({
  running, stats, done, total,
}: {
  running: boolean;
  stats: JobStats | null;
  done: { reason: DoneReason; message?: string } | null;
  total: number;
}) {
  if (!running && !done) return null;

  let cls = 'running';
  let text: string;
  if (running) {
    text = stats?.phase === 'imaging' ? 'Comparing images' : 'Searching marketplaces';
  } else if (done!.reason === 'complete') {
    cls = 'complete';
    text = `Scan complete · ${total} listings`;
  } else if (done!.reason === 'error') {
    cls = 'stopped';
    text = done!.message ?? 'The scan stopped on an error';
  } else {
    cls = 'stopped';
    text =
      done!.reason === 'budget_exhausted'
        ? `Stopped at the request budget · ${total} listings`
        : `Stopped at the time limit · ${total} listings`;
  }

  return (
    <span className={`status ${cls}`}>
      <span className="dot" />
      {text}
      {running && stats && <span className="elapsed">{fmtMs(stats.elapsedMs)}</span>}
    </span>
  );
}

function ResultRow({
  r, open, onToggle,
}: {
  r: ScoredListing; open: boolean; onToggle: () => void;
}) {
  const l = r.listing;
  const cls = r.probability >= 0.7 ? 'high' : r.probability >= 0.4 ? 'mid' : 'low';
  return (
    <div className="lrow">
      <button className="row-head" onClick={onToggle} aria-expanded={open}>
        <div
          className={`ring ${cls} ${r.provisional ? 'prov' : ''}`}
          style={{ ['--p' as string]: `${Math.round(r.probability * 100)}%` }}
        >
          <span>{r.probability.toFixed(2)}</span>
        </div>
        {l.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="thumb" src={l.imageUrl} alt="" loading="lazy" />
        ) : (
          <div className="thumb empty">no image</div>
        )}
        <div className="title-cell">
          <div className="t">{l.title}</div>
          <div className="m">
            <span className="tag">{l.platform === 'amazon' ? 'Amazon' : 'eBay'}</span>
            {l.priceString && <span className="price">{l.priceString}</span>}
            {l.listingType === 'auction' && <span className="tag">Auction</span>}
            {l.condition === 'used' && <span className="tag">Used</span>}
            {r.provisional && <span className="tag scoring">Scoring image…</span>}
            <span>“{l.sourceQuery}”</span>
          </div>
        </div>
        <span className={`chev ${open ? 'open' : ''}`}>›</span>
      </button>

      {open && (
        <div className="detail">
          <h4>Why this score</h4>
          <ul className="reasons">
            {r.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>

          <h4>Signals</h4>
          {Object.entries(r.signals).map(([name, sig]) => (
            <SignalBar key={name} name={name} sig={sig} />
          ))}

          <details className="rawvals">
            <summary>Raw signal values</summary>
            <pre>
              {Object.entries(r.signals)
                .map(([name, sig]) => `${name}: ${JSON.stringify(sig.raw)}`)
                .join('\n')}
            </pre>
          </details>

          <div>
            <a className="visit" href={l.url} target="_blank" rel="noopener noreferrer">
              View on {l.platform === 'amazon' ? 'Amazon' : 'eBay'} ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function SignalBar({ name, sig }: { name: string; sig: SignalResult }) {
  return (
    <div className={`sig ${sig.unavailable ? 'na' : ''}`}>
      <span className="sig-name">{SIGNAL_LABELS[name] ?? name}</span>
      <span className="sig-bar">
        <i style={{ width: `${(sig.unavailable ? 0 : sig.p) * 100}%` }} />
      </span>
      <span className="sig-p">{sig.unavailable ? '—' : sig.p.toFixed(3)}</span>
    </div>
  );
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
