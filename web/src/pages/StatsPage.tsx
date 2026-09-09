import { useState } from "react";
import { api, type RunEvent, type RunStats } from "../api.ts";
import { formatDurationMs, formatTokens } from "../lib/format.ts";

/**
 * Stats view over the read-only RunStats DTO (arch §3): 200 + partial body,
 * never throws. Reuses computeStats verbatim — no second statistical engine.
 * Observed metrics: pass rate, average attempts, average duration, average
 * turns, average tools, average tokens (+ token total), top failing gates,
 * per-model fallback counts, and handoffs. Unknown cells render "—", never 0.
 * The query panel below reuses the queryEvents DSL behind GET …/query.
 */

type StatsInput = RunStats | Record<string, unknown> | null;

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtCount(v: unknown): string {
  const n = asNum(v);
  if (n === null) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtMean(v: unknown): string {
  const n = asNum(v);
  if (n === null) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtDuration(v: unknown): string {
  const n = asNum(v);
  return n === null ? "—" : formatDurationMs(n);
}

function fmtTokens(v: unknown): string {
  const n = asNum(v);
  return n === null ? "—" : formatTokens(n);
}

function readTotals(stats: Record<string, unknown>): Record<string, number> {
  const raw = stats["totals"];
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function readGates(stats: Record<string, unknown>): { command: string; fails: number }[] {
  const raw = stats["topFailingGates"];
  if (!Array.isArray(raw)) return [];
  const out: { command: string; fails: number }[] = [];
  for (const g of raw as Record<string, unknown>[]) {
    if (!g || typeof g !== "object") continue;
    const command = typeof g["command"] === "string" ? (g["command"] as string) : typeof g["gate"] === "string" ? (g["gate"] as string) : null;
    const fails = typeof g["fails"] === "number" ? (g["fails"] as number) : null;
    if (command !== null && fails !== null) out.push({ command, fails });
  }
  return out;
}

function readFallbacks(stats: Record<string, unknown>): [string, number][] {
  const raw = stats["modelFallbacks"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: [string, number][] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out.push([k, v]);
  }
  return out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

interface EffortRow {
  key: string;
  count: string;
  done: string;
  duration: string;
  turns: string;
  tools: string;
  tokens: string;
}

function readByEffort(stats: Record<string, unknown>): EffortRow[] {
  const raw = stats["byEffort"];
  if (!raw || typeof raw !== "object") return [];
  const rows: EffortRow[] = [];
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") {
      rows.push({ key, count: fmtCount(val), done: "—", duration: "—", turns: "—", tools: "—", tokens: "—" });
      continue;
    }
    const g = val as Record<string, unknown>;
    rows.push({
      key,
      count: fmtCount(g["count"]),
      done: fmtCount(g["done"]),
      duration: fmtDuration(g["meanDurationMs"]),
      turns: fmtMean(g["meanTurns"]),
      tools: fmtMean(g["meanTools"]),
      tokens: fmtTokens(g["meanTokens"]),
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

function eventLine(e: RunEvent): string {
  const slice = e.sliceId ? ` ${e.sliceId}` : "";
  const extra = e.detail ?? e.reason ?? "";
  return `#${e.seq} ${e.at} ${e.type}${slice}${extra ? ` — ${extra}` : ""}`;
}

function QueryPanel({ runId }: { runId: string }) {
  const [q, setQ] = useState("all where durationMs > 1500");
  const [results, setResults] = useState<RunEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runQuery = async () => {
    const query = q.trim();
    if (!query) {
      setError("empty query");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.query(runId, query);
      setResults(res.events);
    } catch (err) {
      setResults(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="omp-panel" aria-label="Query events">
      <h2>Query events</h2>
      <p className="omp-hint">
        Same DSL as <code>queryEvents</code>: <code>all</code>, <code>failed</code>, <code>slice &lt;id&gt;</code>,{" "}
        <code>slices</code> with optional <code>where &lt;field&gt; &lt;op&gt; &lt;value&gt; (and …)</code>. Fields: attempts,
        attempt, exit, durationMs, turns, tools, slice, id, reason, type.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="omp-input"
          style={{ flex: "1 1 280px" }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runQuery();
          }}
          placeholder="all where durationMs > 1500"
          aria-label="Event query"
        />
        <button className="omp-btn" data-primary="true" onClick={() => void runQuery()} disabled={loading} aria-label="Run query">
          {loading ? "Querying…" : "Run query"}
        </button>
      </div>
      {error && (
        <p className="omp-error" role="alert">
          {error}
        </p>
      )}
      {results !== null && !error && (
        <p className="omp-hint" aria-live="polite">
          {results.length} event{results.length === 1 ? "" : "s"} matched.
        </p>
      )}
      {results !== null && results.length > 0 && !error && (
        <div className="omp-table-wrap">
          <table className="omp-table" style={{ minWidth: 0 }}>
            <thead>
              <tr>
                <th scope="col">seq</th>
                <th scope="col">type</th>
                <th scope="col">slice</th>
                <th scope="col">detail</th>
              </tr>
            </thead>
            <tbody>
              {results.slice(0, 50).map((e) => (
                <tr key={e.seq} style={{ cursor: "default" }} title={eventLine(e)}>
                  <td>{e.seq}</td>
                  <td>
                    <code>{e.type}</code>
                  </td>
                  <td>{e.sliceId ?? "—"}</td>
                  <td style={{ overflowWrap: "anywhere" }}>{e.detail ?? e.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {results.length > 50 && <p className="omp-hint">Showing first 50 of {results.length}.</p>}
        </div>
      )}
      {results !== null && results.length === 0 && !error && <p className="omp-hint">No events matched.</p>}
    </section>
  );
}

export default function StatsPage({ stats, runId }: { stats: StatsInput; runId?: string | null }) {
  if (!stats) {
    return (
      <section className="omp-panel" aria-label="Stats">
        <h2>Stats</h2>
        <p className="omp-hint">Loading stats…</p>
      </section>
    );
  }

  const s = stats as Record<string, unknown>;
  const totals = readTotals(s);
  const gates = readGates(s);
  const fallbacks = readFallbacks(s);
  const byEffort = readByEffort(s);
  const fallbackTotal = fallbacks.reduce((a, [, n]) => a + n, 0);

  const attemptsRaw = s["attempts"] as { total?: unknown; perSlice?: unknown } | undefined;
  const attemptsTotal = typeof attemptsRaw?.total === "number" ? attemptsRaw.total : null;
  const sliceCount = Object.values(totals).reduce((a, b) => a + b, 0);
  const meanAttemptsRaw = asNum(s["meanAttempts"]) ?? (attemptsTotal !== null && sliceCount > 0 ? attemptsTotal / sliceCount : null);
  const meanAttempts = meanAttemptsRaw === null ? "—" : Number.isInteger(meanAttemptsRaw) ? String(meanAttemptsRaw) : meanAttemptsRaw.toFixed(1);

  const passRate = asNum(s["passRate"]);
  const handoffs = s["handoffs"];
  const handoffsText = typeof handoffs === "number" ? String(handoffs) : "—";

  return (
    <div className="omp-page" aria-label="Stats workspace">
      <section className="omp-panel" aria-label="Stats">
        <h2>Stats</h2>
        <div className="omp-metrics">
          <div className="omp-metric" data-tone="green">
            <div className="omp-metric-num">{passRate === null ? "—" : `${Math.round(passRate * 100)}%`}</div>
            <div className="omp-metric-label">pass rate</div>
          </div>
          <div className="omp-metric">
            <div className="omp-metric-num">{attemptsTotal === null ? "—" : String(attemptsTotal)}</div>
            <div className="omp-metric-label">attempts (total)</div>
          </div>
          <div className="omp-metric">
            <div className="omp-metric-num">{meanAttempts}</div>
            <div className="omp-metric-label">avg attempts / slice</div>
          </div>
          <div className="omp-metric" data-tone="cyan">
            <div className="omp-metric-num">{fmtMean(s["meanTurns"])}</div>
            <div className="omp-metric-label">avg turns</div>
          </div>
          <div className="omp-metric" data-tone="cyan">
            <div className="omp-metric-num">{fmtMean(s["meanTools"])}</div>
            <div className="omp-metric-label">avg tools</div>
          </div>
          <div className="omp-metric">
            <div className="omp-metric-num">{fmtDuration(s["meanDurationMs"])}</div>
            <div className="omp-metric-label">avg duration</div>
          </div>
          <div className="omp-metric" data-tone="cyan">
            <div className="omp-metric-num">{fmtTokens(s["meanTokens"])}</div>
            <div className="omp-metric-label">avg tokens</div>
          </div>
          <div className="omp-metric">
            <div className="omp-metric-num">{fmtTokens(s["tokensTotal"])}</div>
            <div className="omp-metric-label">tokens (total)</div>
          </div>
          <div className="omp-metric">
            <div className="omp-metric-num">{handoffsText}</div>
            <div className="omp-metric-label">handoffs</div>
          </div>
          <div className="omp-metric" data-tone="amber">
            <div className="omp-metric-num">{fallbacks.length === 0 ? "—" : String(fallbackTotal)}</div>
            <div className="omp-metric-label">model fallbacks</div>
          </div>
        </div>
        {Object.keys(totals).length > 0 && (
          <>
            <h3>Totals</h3>
            <div className="omp-metrics">
              {Object.entries(totals).map(([k, v]) => (
                <div className="omp-metric" key={k}>
                  <div className="omp-metric-num">{fmtCount(v)}</div>
                  <div className="omp-metric-label">{k}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <div className="omp-stats-grid">
        <section className="omp-panel" aria-label="By effort">
          <h2>By effort</h2>
          {byEffort.length === 0 ? (
            <p className="omp-hint">No effort breakdown.</p>
          ) : (
            <div className="omp-table-wrap">
              <table className="omp-table" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th scope="col">effort</th>
                    <th scope="col">slices</th>
                    <th scope="col">done</th>
                    <th scope="col">avg duration</th>
                    <th scope="col">avg turns</th>
                    <th scope="col">avg tools</th>
                    <th scope="col">avg tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {byEffort.map((r) => (
                    <tr key={r.key} style={{ cursor: "default" }}>
                      <td>
                        <code>{r.key}</code>
                      </td>
                      <td>{r.count}</td>
                      <td>{r.done}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.duration}</td>
                      <td>{r.turns}</td>
                      <td>{r.tools}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.tokens}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="omp-panel" aria-label="Top failing gates">
          <h2>Top failing gates</h2>
          {gates.length === 0 ? (
            <p className="omp-hint">No failing gates recorded.</p>
          ) : (
            <ul className="omp-list">
              {gates.map((g) => (
                <li key={g.command} className="omp-list-item" style={{ cursor: "default" }}>
                  <code>{g.fails}×</code>
                  <span style={{ overflowWrap: "anywhere" }}>{g.command}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="omp-panel" aria-label="Model fallbacks">
          <h2>Model fallbacks</h2>
          {fallbacks.length === 0 ? (
            <p className="omp-hint">No model fallbacks recorded.</p>
          ) : (
            <div className="omp-table-wrap">
              <table className="omp-table" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th scope="col">model</th>
                    <th scope="col">count</th>
                  </tr>
                </thead>
                <tbody>
                  {fallbacks.map(([model, count]) => (
                    <tr key={model} style={{ cursor: "default" }}>
                      <td style={{ overflowWrap: "anywhere" }}>
                        <code>{model}</code>
                      </td>
                      <td>{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {runId ? (
        <QueryPanel runId={runId} />
      ) : (
        <section className="omp-panel" aria-label="Query events">
          <h2>Query events</h2>
          <p className="omp-hint">Select a run to query its event log.</p>
        </section>
      )}

      <details className="omp-panel" aria-label="Raw stats">
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Raw stats JSON</summary>
        <pre className="omp-code">{JSON.stringify(stats, null, 2)}</pre>
      </details>
    </div>
  );
}
