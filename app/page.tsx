'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobEvent, JobStats, ScoredListing, DoneReason } from '@/lib/scraper/types';

type SortKey = 'score' | 'price';

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
      setWarnings([`Failed to start job: HTTP ${res.status}`]);
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
    <main>
      <div className="masthead">
        <h1>Comfrt infringement scan</h1>
        <span className="sub">Amazon + eBay · scored by image, brand, title and price signals</span>
      </div>

      <div className="controls">
        <button className="primary" onClick={start} disabled={running}>
          {running ? 'Scanning…' : total > 0 ? 'Run new scan' : 'Run scan'}
        </button>
        {running && stats && <span className="sub">phase: {stats.phase}</span>}
      </div>

      {stats && (
        <div className="statsbar">
          <div className="stat">
            <div className="k">Elapsed</div>
            <div className="v">{fmtMs(stats.elapsedMs)}</div>
          </div>
          <div className="stat">
            <div className="k">ScraperAPI budget</div>
            <div className="v">
              {stats.budget.used}<small> / {stats.budget.max}</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">Amazon requests</div>
            <div className="v">{stats.requests.amazon}</div>
          </div>
          <div className="stat">
            <div className="k">eBay requests</div>
            <div className="v">{stats.requests.ebay}</div>
          </div>
          <div className="stat">
            <div className="k">Image fetches</div>
            <div className="v">{stats.requests.images}<small> (direct CDN)</small></div>
          </div>
          <div className="stat">
            <div className="k">Listings</div>
            <div className="v">{stats.listingsSeen}<small> deduped</small></div>
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

      {done && (
        <div className="done-banner">
          Scan finished — <b>{doneLabel(done.reason)}</b>
          {done.message ? ` · ${done.message}` : ''} · {total} unique listings scored
        </div>
      )}

      {total > 0 && (
        <div className="filters">
          <label>
            min score
            <input
              type="range" min={0} max={0.9} step={0.05} value={minScore}
              onChange={(e) => setMinScore(parseFloat(e.target.value))}
            />
            <span className="thresh">{minScore.toFixed(2)}</span>
          </label>
          <label>
            <input
              type="checkbox" checked={platforms.amazon}
              onChange={(e) => setPlatforms((p) => ({ ...p, amazon: e.target.checked }))}
            />
            Amazon
          </label>
          <label>
            <input
              type="checkbox" checked={platforms.ebay}
              onChange={(e) => setPlatforms((p) => ({ ...p, ebay: e.target.checked }))}
            />
            eBay
          </label>
          <label>
            sort
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="score">score (high → low)</option>
              <option value="price">price (low → high)</option>
            </select>
          </label>
          <span>
            showing {visible.length} of {total}
          </span>
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
        {total === 0 && !running && (
          <div className="empty-state">
            Run a scan to search Amazon and eBay for listings that resemble authentic
            Comfrt products. Results stream in as they are scored.
          </div>
        )}
        {total > 0 && visible.length === 0 && (
          <div className="empty-state">No listings above the current filters — lower the score threshold.</div>
        )}
      </div>
    </main>
  );
}

function ResultRow({
  r, open, onToggle,
}: {
  r: ScoredListing; open: boolean; onToggle: () => void;
}) {
  const cls = r.probability >= 0.7 ? 'high' : r.probability >= 0.4 ? 'mid' : 'low';
  const l = r.listing;
  return (
    <div className="row">
      <div className="row-head" onClick={onToggle}>
        <div className={`score ${cls}`}>{r.probability.toFixed(2)}</div>
        {l.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="thumb" src={l.imageUrl} alt="" loading="lazy" />
        ) : (
          <div className="thumb empty">no img</div>
        )}
        <div className="title-cell">
          <div className="t">{l.title}</div>
          <div className="m">
            <span className={`badge ${l.platform}`}>{l.platform}</span>
            {l.priceString && <span>{l.priceString}</span>}
            {l.listingType === 'auction' && <span className="badge">auction</span>}
            {r.provisional && <span className="badge prov">image pending</span>}
            <span>via “{l.sourceQuery}”</span>
          </div>
        </div>
        <span className="chev">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="detail">
          <h4>Why this score</h4>
          <ul className="reasons">
            {r.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
          <h4>Signal values (raw)</h4>
          <table className="sigtable">
            <thead>
              <tr><th>signal</th><th className="p">p</th><th>raw</th></tr>
            </thead>
            <tbody>
              {Object.entries(r.signals).map(([name, sig]) => (
                <tr key={name}>
                  <td>{name}{sig.unavailable ? ' (unavailable)' : ''}</td>
                  <td className="p">{sig.unavailable ? '—' : sig.p.toFixed(3)}</td>
                  <td className="raw">{JSON.stringify(sig.raw)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Listing</h4>
          <a href={l.url} target="_blank" rel="noopener noreferrer">
            {l.url}
          </a>
        </div>
      )}
    </div>
  );
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function doneLabel(reason: DoneReason): string {
  return {
    complete: 'all queries completed',
    budget_exhausted: 'stopped at request budget',
    time_exhausted: 'stopped at time budget',
    error: 'error',
  }[reason];
}
