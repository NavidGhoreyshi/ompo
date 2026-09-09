import { useEffect, useState } from "react";
import type { RunEvent, SliceDetail, SliceSummary } from "../api.ts";
import ControlPanel from "./ControlPanel.tsx";
import DiffView from "./DiffView.tsx";
import EventsView from "./EventsView.tsx";
import ExecutionTrace from "./ExecutionTrace.tsx";
import LogView from "./LogView.tsx";
import OutputView from "./OutputView.tsx";
import PromptView from "./PromptView.tsx";
import ReviewView from "./ReviewView.tsx";
import { symbolForStatus, toneForStatus } from "./StatusBadge.tsx";
import Usage from "./Usage.tsx";
import VerifyView from "./VerifyView.tsx";

const TABS = ["Output", "Diff", "Verify", "Review", "Prompt", "Events", "Usage", "Log"] as const;

/**
 * Active-slice inspector: the selected slice is always populated — App
 * auto-selects the slice that needs eyes, so this never renders a giant
 * "select a slice" rectangle while slices exist. Header states identity
 * (id, title, status, attempt, generation); Output leads with the execution
 * lifecycle; Diff/Verify/Review/Prompt/Events/Usage/Log follow as readable
 * surfaces, not raw dumps. Control stays in context below the views.
 */
export default function Inspector({
  runId,
  selected,
  detail,
  onControlDone,
  slices,
  events = [],
  live,
}: {
  runId: string;
  selected: SliceSummary | undefined;
  detail: SliceDetail | Record<string, unknown> | null;
  onControlDone: () => void;
  slices: SliceSummary[];
  events?: RunEvent[];
  live?: boolean;
}) {
  const [tab, setTab] = useState(0);

  // New selection starts on Output; tab state never leaks across slices.
  useEffect(() => {
    setTab(0);
  }, [selected?.id]);

  if (!selected) {
    return (
      <div className="omp-inspector-empty" aria-label="Inspector">
        <p className="omp-hint">No slices yet — the inspector populates once the run has slices.</p>
      </div>
    );
  }

  const d = detail as SliceDetail | null;
  const sel = selected;
  const tone = toneForStatus(sel.status);

  return (
    <div className="omp-inspector-panel" aria-label="Inspector" aria-live="polite">
      <div className="omp-inspector-head">
        <span className="omp-section-label">Active slice</span>
        <h2 className="omp-inspector-title">
          <code>{sel.id}</code> {sel.title}
        </h2>
        <p className="omp-inspector-state">
          <span aria-hidden="true" className="omp-status-sym" data-tone={tone}>
            {symbolForStatus(sel.status)}
          </span>
          <span className="omp-board-state" data-tone={tone}>
            {sel.status}
          </span>
          <span className="omp-hint">
            attempt {sel.attempts} · gen {sel.generation}
            {sel.effort ? ` · ${sel.effort}` : ""}
            {sel.agent ? ` · ${sel.agent}` : ""}
            {sel.deps.length > 0 ? ` · needs ${sel.deps.join(", ")}` : ""}
          </span>
        </p>
        {sel.reason && <p className="omp-inspector-reason">{sel.reason}</p>}
      </div>

      <ExecutionTrace selected={sel} detail={d} />

      <div className="omp-tabs" role="tablist" aria-label="Inspector views">
        {TABS.map((t, i) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === i}
            aria-label={`${i + 1}:${t}`}
            className="omp-tab"
            data-active={tab === i ? "true" : "false"}
            onClick={() => setTab(i)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") setTab((i + 1) % TABS.length);
              if (e.key === "ArrowLeft") setTab((i + TABS.length - 1) % TABS.length);
            }}
          >
            {t}
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
        {tab === 6 && <Usage detail={d} />}
        {tab === 7 && <LogView runId={runId} sliceId={sel.id} active={sel.status === "running" || sel.status === "verifying"} />}
      </div>

      <h3 className="omp-section-label">Control</h3>
      <ControlPanel runId={runId} slices={slices} initialSliceId={sel.id} onDone={onControlDone} events={events} live={live} />

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
