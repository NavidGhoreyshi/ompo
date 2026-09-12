import { useEffect, useMemo, useRef } from "react";
import type { RunEvent, SliceSummary } from "../api.ts";
import { alignLineIds, buildLiveStream, compactWindow, type StreamEntry } from "./stream.ts";
import { useSliceLog } from "./useSliceLog.ts";

/**
 * Worker-log lines pulled per poll. The expanded log renders every one of
 * them (server cap is 500), so "View full log" never shows less than the
 * forensic tail an operator would read in the TUI.
 */
export const LIVE_TAIL = 400;

export interface LiveStreamState {
  /** Worker log file being tailed, `null` before one exists. */
  logName: string | null;
  /** Raw lines as fetched — the expanded view's source of truth. */
  lines: string[];
  /** Line ordinals aligned to `lines` — the stable row keys. */
  ids: number[];
  /** Semantic entries: lifecycle events around the current worker output. */
  entries: StreamEntry[];
  /** The compact window: newest meaningful entries, plus leading raw output. */
  compact: StreamEntry[];
  error: string | null;
  loading: boolean;
}

/**
 * One slice's live output for the Overview: the polled worker-log tail plus
 * the semantic stream derived from it and the run's event log. Polling and
 * reset-on-target-change live in `useSliceLog`; this hook adds line identity
 * (stable keys across polls, for enter/leave motion) and the compact window.
 */
export function useLiveStream(runId: string | null, slice: SliceSummary | null, events: RunEvent[]): LiveStreamState {
  const active = slice !== null && (slice.status === "running" || slice.status === "verifying");
  const { name, lines, error, loading } = useSliceLog(runId, slice?.id ?? null, active, LIVE_TAIL);
  // Line ordinals are recovered by aligning each poll against the previous
  // one. The ref caches that comparison: read during render (pure), written
  // after commit so no render phase mutates shared state.
  const prevRef = useRef<{ lines: string[]; ids: number[] }>({ lines: [], ids: [] });
  const ids = useMemo(() => alignLineIds(prevRef.current, lines), [lines]);
  useEffect(() => {
    prevRef.current = { lines, ids };
  }, [lines, ids]);
  const entries = useMemo(
    () => buildLiveStream({ events, sliceId: slice?.id ?? null, lines, ids, logName: name }),
    [events, slice?.id, lines, ids, name],
  );
  return { logName: name, lines, ids, entries, compact: compactWindow(entries), error, loading };
}
