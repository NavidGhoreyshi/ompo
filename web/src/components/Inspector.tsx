import { useEffect, useState } from "react";
import {
  LuCoins,
  LuEye,
  LuFileDiff,
  LuFileText,
  LuList,
  LuMessageSquareText,
  LuScrollText,
  LuShieldCheck,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";
import type { IconType } from "react-icons";
import type { RunEvent, SliceDetail, SliceSummary } from "../api.ts";
import ControlPanel from "./ControlPanel.tsx";
import DiffView from "./DiffView.tsx";
import EventsView from "./EventsView.tsx";
import ExecutionTrace from "./ExecutionTrace.tsx";
import LogView from "./LogView.tsx";
import OutputView from "./OutputView.tsx";
import PromptView from "./PromptView.tsx";
import ReviewView from "./ReviewView.tsx";
import { StatusSymbol } from "./icons.tsx";
import { toneForStatus } from "../lib/status.ts";
import { Separator } from "./ui/separator.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import Usage from "./Usage.tsx";
import VerifyView from "./VerifyView.tsx";
import { formatDurationMs } from "../lib/format.ts";

export type InspectorTab = "Output" | "Diff" | "Verify" | "Review" | "Prompt" | "Events" | "Usage" | "Log";

/**
 * The tabs, in the order the surface renders them. Exported because the deck's
 * dock addresses them by position (`1`…`8`, `scene/dock.ts`): a second list
 * with a second order is exactly how two surfaces drift apart.
 */
export const INSPECTOR_TABS: readonly { id: InspectorTab; icon: IconType }[] = [
  { id: "Output", icon: LuFileText },
  { id: "Diff", icon: LuFileDiff },
  { id: "Verify", icon: LuShieldCheck },
  { id: "Review", icon: LuEye },
  { id: "Prompt", icon: LuMessageSquareText },
  { id: "Events", icon: LuList },
  { id: "Usage", icon: LuCoins },
  { id: "Log", icon: LuScrollText },
];

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
  onClose,
  slices,
  events = [],
  live,
  wedged,
  tab: tabProp,
  onTabChange,
}: {
  runId: string;
  selected: SliceSummary | undefined;
  detail: SliceDetail | Record<string, unknown> | null;
  onControlDone: () => void;
  /** Closes the contextual drawer (App owns the open state). */
  onClose: () => void;
  slices: SliceSummary[];
  events?: RunEvent[];
  live?: boolean;
  /** Selected slice reads as wedged (stale transcript under a live lock). */
  wedged?: boolean;
  /**
   * Controlled tab. Omitted — the dashboard's drawer — the panel owns it.
   * The deck's dock passes it so `1`…`8` address a tab directly; both modes
   * share one reset rule (below), so the surfaces cannot disagree.
   */
  tab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
}) {
  const [ownTab, setOwnTab] = useState<InspectorTab>("Output");
  const tab = tabProp ?? ownTab;
  const setTab = (next: InspectorTab): void => {
    setOwnTab(next);
    onTabChange?.(next);
  };

  // New selection starts on Output; tab state never leaks across slices. When
  // the tab is controlled the owner applies this rule (the dock holds the tab
  // so the deck's keys can address it) — the reset must not fight the open-on-
  // tab-N command, which is why it lives with the state's owner.
  useEffect(() => {
    if (tabProp === undefined) setOwnTab("Output");
    // The reset is keyed to the subject, not to the setter's identity.
  }, [selected?.id, tabProp]);

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
        <div className="omp-inspector-closebar">
          <span className="omp-section-label">Inspector</span>
          <button type="button" className="omp-icon-btn" onClick={onClose} aria-label="Close inspector" title="Close inspector">
            <LuX aria-hidden="true" className="size-4" />
          </button>
        </div>
        <h2 className="omp-inspector-title">
          <code>{sel.id}</code> {sel.title}
        </h2>
        <p className="omp-inspector-state">
          <span aria-hidden="true" className="omp-status-sym" data-tone={tone}>
            <StatusSymbol status={sel.status} />
          </span>
          <span className="omp-inspector-status" data-tone={tone}>
            {sel.status}
          </span>
          <span>
            attempt {sel.attempts} · gen {sel.generation}
            {sel.effort ? ` · ${sel.effort}` : ""}
            {sel.agent ? ` · ${sel.agent}` : ""}
            {sel.deps.length > 0 ? ` · needs ${sel.deps.join(", ")}` : ""}
          </span>
        </p>
        {d?.verdictStall && (
          <div className="omp-stall" role="status">
            <LuTriangleAlert aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />
            <span>
              <strong>No verdict output for {formatDurationMs(d.verdictStall.idleMs)}</strong>
              {d.verdictStall.lastGate ? ` — last gate: ${d.verdictStall.lastGate}` : ""}
              {d.verdictStall.gatesDone > 0 ? ` (${d.verdictStall.gatesDone} done)` : " (no gate finished)"}. Healthy long
              gates go quiet too — but if the loop is unresponsive, retry and resume cannot advance it; interrupt the loop
              (Ctrl-C) and run <code>ompo resume --run {runId}</code>.
            </span>
          </div>
        )}
        {sel.reason && <p className="omp-inspector-reason">{sel.reason}</p>}
      </div>

      <Separator className="my-1" />

      <ExecutionTrace selected={sel} detail={d} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as InspectorTab)}>
        <TabsList className="omp-tabs" aria-label="Inspector views">
          {INSPECTOR_TABS.map((t) => {
            const TabIcon = t.icon;
            return (
              <TabsTrigger key={t.id} value={t.id} className="omp-tab">
                <TabIcon aria-hidden="true" className="size-3.5 shrink-0" />
                {t.id}
              </TabsTrigger>
            );
          })}
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
          <ReviewView detail={d} runId={runId} />
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
      <ControlPanel runId={runId} slices={slices} initialSliceId={sel.id} onDone={onControlDone} events={events} live={live} verdictStalled={!!d?.verdictStall} wedged={wedged} />

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
