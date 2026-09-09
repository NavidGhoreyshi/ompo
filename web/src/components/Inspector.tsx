import { useEffect, useState } from "react";
import type { SliceDetail, SliceSummary } from "../api.ts";
import ControlPanel from "./ControlPanel.tsx";
import DiffView from "./DiffView.tsx";
import EventsView from "./EventsView.tsx";
import OutputView from "./OutputView.tsx";
import PromptView from "./PromptView.tsx";
import ReviewView from "./ReviewView.tsx";
import StatusBadge from "./StatusBadge.tsx";
import VerifyView from "./VerifyView.tsx";

const TABS = ["Output", "Diff", "Verify", "Review", "Prompt", "Events"] as const;

/** Right-hand inspector: selected-slice detail as six TUI-parity tabs + contextual control. */
export default function Inspector({
  runId,
  selected,
  detail,
  onClose,
  onControlDone,
  slices,
}: {
  runId: string;
  selected: SliceSummary | undefined;
  detail: SliceDetail | Record<string, unknown> | null;
  onClose: () => void;
  onControlDone: () => void;
  slices: SliceSummary[];
}) {
  const [tab, setTab] = useState(0);

  // New selection starts on Output; tab state never leaks across slices.
  useEffect(() => {
    setTab(0);
  }, [selected?.id]);

  if (!selected) {
    return (
      <div className="omp-panel" aria-label="Inspector">
        <div className="omp-inspector-head">
          <h2>Inspector</h2>
        </div>
        <p className="omp-hint">Select a slice in Overview, Roadmap, or Agents to inspect it. Control actions appear here, in context.</p>
      </div>
    );
  }

  const d = detail as SliceDetail | null;
  const sel = selected;

  return (
    <div className="omp-panel" aria-label="Inspector" aria-live="polite">
      <div className="omp-inspector-head">
        <h2>
          <code>{sel.id}</code> — {sel.title}
        </h2>
        <button className="omp-icon-btn" onClick={onClose} aria-label="Close inspector" style={{ marginLeft: "auto" }}>
          ✕
        </button>
      </div>
      <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <StatusBadge status={sel.status} />
        {sel.reason && <span className="omp-list-reason">{sel.reason}</span>}
      </div>
      <dl className="omp-kv">
        <dt>attempt</dt>
        <dd>{sel.attempts}</dd>
        <dt>generation</dt>
        <dd>{sel.generation}</dd>
        <dt>updated</dt>
        <dd>{sel.updatedAt}</dd>
        {sel.effort && (
          <>
            <dt>effort</dt>
            <dd>{sel.effort}</dd>
          </>
        )}
        {sel.agent && (
          <>
            <dt>agent</dt>
            <dd>{sel.agent}</dd>
          </>
        )}
        {sel.deps.length > 0 && (
          <>
            <dt>deps</dt>
            <dd>{sel.deps.join(", ")}</dd>
          </>
        )}
      </dl>

      <div className="omp-filter-chips" role="tablist" aria-label="Inspector views">
        {TABS.map((t, i) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === i}
            aria-label={`${i + 1}:${t}`}
            className="omp-chip"
            onClick={() => setTab(i)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") setTab((i + 1) % TABS.length);
              if (e.key === "ArrowLeft") setTab((i + TABS.length - 1) % TABS.length);
            }}
          >
            {i + 1}:{t}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={TABS[tab]}>
        {tab === 0 && <OutputView selected={sel} detail={d} />}
        {tab === 1 && <DiffView runId={runId} sliceId={sel.id} detail={d} />}
        {tab === 2 && <VerifyView detail={d} />}
        {tab === 3 && <ReviewView detail={d} />}
        {tab === 4 && <PromptView selected={sel} detail={d} />}
        {tab === 5 && <EventsView runId={runId} sliceId={sel.id} detail={d} />}
      </div>

      <h3>Control</h3>
      <ControlPanel runId={runId} slices={slices} initialSliceId={sel.id} onDone={onControlDone} />

      {d && (
        <details>
          <summary>Raw detail</summary>
          <div className="omp-detail-body">
            <pre className="omp-code">{JSON.stringify(d, null, 2)}</pre>
          </div>
        </details>
      )}
    </div>
  );
}
