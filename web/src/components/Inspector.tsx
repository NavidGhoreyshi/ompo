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
import { Separator } from "./ui/separator.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
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
  const [tab, setTab] = useState<(typeof TABS)[number]>("Output");

  // New selection starts on Output; tab state never leaks across slices.
  useEffect(() => {
    setTab("Output");
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

      <Separator className="my-1" />

      <ExecutionTrace selected={sel} detail={d} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as (typeof TABS)[number])}>
        <TabsList className="omp-tabs" aria-label="Inspector views">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t} className="omp-tab">
              {t}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="Output">
          <OutputView selected={sel} detail={d} />
        </TabsContent>
        <TabsContent value="Diff">
          <DiffView runId={runId} sliceId={sel.id} detail={d} />
        </TabsContent>
        <TabsContent value="Verify">
          <VerifyView detail={d} />
        </TabsContent>
        <TabsContent value="Review">
          <ReviewView detail={d} />
        </TabsContent>
        <TabsContent value="Prompt">
          <PromptView selected={sel} detail={d} />
        </TabsContent>
        <TabsContent value="Events">
          <EventsView runId={runId} sliceId={sel.id} detail={d} />
        </TabsContent>
        <TabsContent value="Usage">
          <Usage detail={d} />
        </TabsContent>
        <TabsContent value="Log">
          <LogView runId={runId} sliceId={sel.id} active={sel.status === "running" || sel.status === "verifying"} />
        </TabsContent>
      </Tabs>

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
