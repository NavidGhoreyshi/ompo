import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type PlanPreviewEnvelope } from "../api.ts";
import Dag from "../components/Dag.tsx";
import PlannerPreview from "../components/PlannerPreview.tsx";
import StatusBadge from "../components/StatusBadge.tsx";

const FILTERS = ["all", "pending", "blocked", "running", "verifying", "failed", "aborted", "blocked-env", "done", "skipped"] as const;

export default function RoadmapPage({
  detail,
  selected,
  onSelect,
}: {
  detail: RunDetail | null;
  selected: string | null;
  onSelect: (sliceId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [preview, setPreview] = useState<PlanPreviewEnvelope | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [raw, setRaw] = useState<{ path: string; markdown: string } | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await api.planPreview());
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const handleReload = useCallback(async () => {
    setNotice(null);
    await loadPreview();
    if (rawOpen) {
      try {
        setRaw(await api.planRoadmap());
      } catch {
        setRaw(null);
      }
    }
  }, [loadPreview, rawOpen]);

  const handleToggleRaw = useCallback(async () => {
    if (rawOpen) {
      setRawOpen(false);
      return;
    }
    setRawOpen(true);
    if (!raw) {
      try {
        setRaw(await api.planRoadmap());
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    }
  }, [raw, rawOpen]);

  const decide = useCallback(
    async (decision: "accept" | "abort") => {
      setBusy(true);
      try {
        const res = await api.planDecision(decision);
        setNotice(res.summary);
        await loadPreview();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [loadPreview],
  );

  const rows = useMemo(() => {
    if (!detail) return [];
    const q = query.trim().toLowerCase();
    return detail.slices.filter((s) => {
      if (filter !== "all" && s.status !== filter) return false;
      if (q && !`${s.id} ${s.title} ${s.reason ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [detail, query, filter]);

  return (
    <div className="omp-page" aria-label="Roadmap workspace">
      <PlannerPreview
        preview={preview}
        loading={previewLoading}
        error={previewError}
        raw={raw}
        rawOpen={rawOpen}
        busy={busy}
        notice={notice}
        onReload={() => void handleReload()}
        onToggleRaw={() => void handleToggleRaw()}
        onAccept={() => void decide("accept")}
        onAbort={() => void decide("abort")}
      />
      <section className="omp-panel" aria-label="Roadmap">
        <h2>Roadmap{detail ? ` — ${detail.slices.length} slices` : ""}</h2>
      <div className="omp-controls" style={{ marginBottom: 8 }}>
        <input
          className="omp-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter slices…"
          aria-label="Filter slices"
          size={24}
        />
        <div className="omp-filter-chips" role="group" aria-label="Status filter">
          {FILTERS.map((f) => (
            <button
              key={f}
              className="omp-chip"
              aria-pressed={filter === f ? "true" : "false"}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {detail && <Dag slices={detail.slices} selected={selected} onSelect={onSelect} />}
      {!detail ? (
        <p className="omp-hint">Loading run…</p>
      ) : rows.length === 0 ? (
        <p className="omp-hint">No slices match.</p>
      ) : (
        <div className="omp-table-wrap">
          <table className="omp-table">
            <thead>
              <tr>
                <th scope="col">slice</th>
                <th scope="col">title</th>
                <th scope="col">status</th>
                <th scope="col">attempts</th>
                <th scope="col">reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={s.id}
                  data-selected={selected === s.id ? "true" : "false"}
                  onClick={() => onSelect(s.id)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(s.id);
                    }
                  }}
                >
                  <td><code>{s.id}</code></td>
                  <td>{s.title}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td>{s.attempts}</td>
                  <td><div className="omp-ellipsis" title={s.reason ?? ""}>{s.reason ?? ""}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="omp-hint">Select a row to inspect it — control actions live in the inspector, in context.</p>
      </section>
    </div>
  );
}
