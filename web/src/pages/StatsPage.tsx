/** Stats view over the read-only RunStats DTO (arch §3): 200 + partial body, never throws. */

type Stats = Record<string, unknown>;

function num(v: unknown): string {
  return typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : "—";
}

export default function StatsPage({ stats }: { stats: Stats | null }) {
  if (!stats) {
    return (
      <section className="omp-panel" aria-label="Stats">
        <h2>Stats</h2>
        <p className="omp-hint">Loading stats…</p>
      </section>
    );
  }

  const totals = (stats["totals"] as Record<string, unknown> | undefined) ?? {};
  const byEffort = (stats["byEffort"] as Record<string, unknown> | undefined) ?? {};
  const gates = (stats["topFailingGates"] as { gate: string; fails: number }[] | undefined) ?? [];
  const fallbacks = num(stats["modelFallbacks"]);

  return (
    <>
      <section className="omp-panel" aria-label="Stats">
        <h2>Stats</h2>
        <div className="omp-cards">
          <div className="omp-stat-card" data-tone="green">
            <div className="omp-stat-num">{num(stats["passRate"]) === "—" ? "—" : `${Math.round(Number(stats["passRate"]) * 100)}%`}</div>
            <div className="omp-stat-label">pass rate</div>
          </div>
          <div className="omp-stat-card">
            <div className="omp-stat-num">{num(stats["attempts"])}</div>
            <div className="omp-stat-label">attempts</div>
          </div>
          <div className="omp-stat-card" data-tone="cyan">
            <div className="omp-stat-num">{num(stats["meanTurns"])}</div>
            <div className="omp-stat-label">mean turns</div>
          </div>
          <div className="omp-stat-card" data-tone="cyan">
            <div className="omp-stat-num">{num(stats["meanTools"])}</div>
            <div className="omp-stat-label">mean tools</div>
          </div>
          <div className="omp-stat-card">
            <div className="omp-stat-num">{num(stats["meanDurationMs"])}</div>
            <div className="omp-stat-label">mean duration (ms)</div>
          </div>
          <div className="omp-stat-card" data-tone="amber">
            <div className="omp-stat-num">{fallbacks}</div>
            <div className="omp-stat-label">model fallbacks</div>
          </div>
        </div>
        {Object.keys(totals).length > 0 && (
          <>
            <h3>Totals</h3>
            <div className="omp-cards">
              {Object.entries(totals).map(([k, v]) => (
                <div className="omp-stat-card" key={k}>
                  <div className="omp-stat-num">{num(v)}</div>
                  <div className="omp-stat-label">{k}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <section className="omp-panel" aria-label="By effort">
          <h2>By effort</h2>
          {Object.keys(byEffort).length === 0 ? (
            <p className="omp-hint">No effort breakdown.</p>
          ) : (
            <div className="omp-table-wrap">
              <table className="omp-table" style={{ minWidth: 0 }}>
                <thead>
                  <tr><th scope="col">effort</th><th scope="col">slices</th></tr>
                </thead>
                <tbody>
                  {Object.entries(byEffort).map(([k, v]) => (
                    <tr key={k} style={{ cursor: "default" }}>
                      <td><code>{k}</code></td>
                      <td>{num(v)}</td>
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
                <li key={g.gate} className="omp-list-item" style={{ cursor: "default" }}>
                  <code>{g.fails}×</code>
                  <span style={{ overflowWrap: "anywhere" }}>{g.gate}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <details className="omp-panel" aria-label="Raw stats">
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Raw stats JSON</summary>
        <pre className="omp-code">{JSON.stringify(stats, null, 2)}</pre>
      </details>
    </>
  );
}
