import type { LintFinding, PlanPreviewEnvelope } from "../api.ts";
import { StatusSymbol } from "./icons.tsx";

export interface PlannerPreviewProps {
  preview: PlanPreviewEnvelope | null;
  loading: boolean;
  error: string | null;
  raw: { path: string; markdown: string } | null;
  rawOpen: boolean;
  busy: boolean;
  notice: string | null;
  onReload: () => void;
  onToggleRaw: () => void;
  onAccept: () => void;
  onAbort: () => void;
}

const STATUS_META = {
  ready: { label: "READY", tone: "green", symbol: "done" },
  warnings: { label: "WARNINGS", tone: "amber", symbol: "blocked-env" },
  blocked: { label: "BLOCKED", tone: "red", symbol: "failed" },
} as const;

function FindingList({ items, kind }: { items: LintFinding[]; kind: "error" | "warn" }) {
  if (items.length === 0) return null;
  return (
    <ul className="omp-list" aria-label={kind === "error" ? "Blocking errors" : "Warnings"}>
      {items.map((f, i) => (
        <li key={`${f.code}-${f.slice ?? ""}-${i}`} className="omp-list-item">
          <code>
            [{f.code}]{f.slice ? ` ${f.slice}` : ""}
          </code>
          <span className="omp-list-reason">{f.message.split("\n")[0]}</span>
        </li>
      ))}
    </ul>
  );
}

export default function PlannerPreview({
  preview,
  loading,
  error,
  raw,
  rawOpen,
  busy,
  notice,
  onReload,
  onToggleRaw,
  onAccept,
  onAbort,
}: PlannerPreviewProps) {
  const meta = preview ? STATUS_META[preview.status] : null;
  const acceptBlocked = !preview || !preview.exists || preview.status === "blocked";

  return (
    <section className="omp-panel" aria-label="Plan preview">
      <h2>
        Plan preview{" "}
        {meta && (
          <span className="omp-badge" data-tone={meta.tone}>
            <span aria-hidden="true" className="omp-badge-sym" data-tone={meta.tone}>
              <StatusSymbol status={meta.symbol} />
            </span>
            {meta.label}
          </span>
        )}
      </h2>
      {loading && <p className="omp-hint">Loading plan preview…</p>}
      {error && (
        <p className="omp-error" role="alert">
          {error}
        </p>
      )}
      {preview && <p className="omp-hint">{preview.summary}</p>}
      {preview && !preview.exists && (
        <p className="omp-warn">
          No {preview.roadmapPath} on disk — plan from project docs first (<code>ompo init</code>), then reload.
        </p>
      )}
      {preview && preview.rows.length > 0 && (
        <div className="omp-table-wrap">
          <table className="omp-table">
            <thead>
              <tr>
                <th scope="col">slice</th>
                <th scope="col">title</th>
                <th scope="col">effort</th>
                <th scope="col">verify</th>
                <th scope="col">deps</th>
                <th scope="col">files</th>
                <th scope="col">findings</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.id}</code>
                  </td>
                  <td>{r.title}</td>
                  <td>
                    <code>{r.effort}</code>
                  </td>
                  <td>
                    <div className="omp-ellipsis" title={r.verify.join("\n") || "(none)"}>
                      {r.verifyCount === 0 ? "no Verify" : `${r.verifyCount} gate(s)`}
                    </div>
                    {r.verify.map((g) => (
                      <div key={g} className="omp-ellipsis" title={g}>
                        <code>{g}</code>
                      </div>
                    ))}
                  </td>
                  <td>
                    <div className="omp-ellipsis" title={r.deps.join(", ")}>
                      {r.deps.length > 0 ? r.deps.join(", ") : "—"}
                    </div>
                  </td>
                  <td>
                    <div className="omp-ellipsis" title={r.files.join(", ") || "(none)"}>
                      {r.files.length > 0 ? r.files.join(", ") : "(none)"}
                    </div>
                  </td>
                  <td>
                    {r.errors.length === 0 && r.warnings.length === 0 ? (
                      "—"
                    ) : (
                      <span>
                        {r.errors.length > 0 && <span>✕ {r.errors.length} error(s)</span>}
                        {r.errors.length > 0 && r.warnings.length > 0 && " · "}
                        {r.warnings.length > 0 && <span>▲ {r.warnings.length} warning(s)</span>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview && preview.errors.length > 0 && (
        <div role={preview.status === "blocked" ? "alert" : undefined}>
          <h3>Blocking errors</h3>
          <FindingList items={preview.errors} kind="error" />
        </div>
      )}
      {preview && preview.warnings.length > 0 && (
        <div>
          <h3>Warnings</h3>
          <FindingList items={preview.warnings} kind="warn" />
        </div>
      )}
      {preview && preview.surveyed.length > 0 && (
        <details>
          <summary>Files surveyed ({preview.surveyed.length})</summary>
          <ul className="omp-list">
            {preview.surveyed.map((s) => (
              <li key={s.path} className="omp-list-item">
                <code>{s.path}</code>
                <span className="omp-list-reason">{new Date(s.mtimeMs).toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="omp-controls" style={{ marginTop: 8 }}>
        <button
          className="omp-btn"
          data-primary="true"
          onClick={onAccept}
          disabled={acceptBlocked || busy || loading}
          title={
            !preview || !preview.exists
              ? "No roadmap on disk to accept"
              : preview.status === "blocked"
                ? "Blocked plans cannot be accepted — fix the errors and reload"
                : `Accept ${preview.rows.length} slice(s)`
          }
        >
          Accept
        </button>
        <button className="omp-btn" onClick={onReload} disabled={busy || loading}>
          Reload from disk
        </button>
        <button
          className="omp-btn"
          onClick={onToggleRaw}
          aria-expanded={rawOpen ? "true" : "false"}
          disabled={!preview || !preview.exists || busy || loading}
        >
          {rawOpen ? "Close ROADMAP" : "Open ROADMAP"}
        </button>
        <button className="omp-btn" onClick={onAbort} disabled={busy || loading}>
          Abort
        </button>
      </div>
      {notice && <p className="omp-hint">{notice}</p>}
      {rawOpen && raw && (
        <details open>
          <summary>
            {raw.path} (read-only)
          </summary>
          <pre className="omp-code" style={{ whiteSpace: "pre-wrap" }}>
            {raw.markdown}
          </pre>
        </details>
      )}
    </section>
  );
}
