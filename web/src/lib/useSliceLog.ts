import { useEffect, useRef, useState } from "react";
import { api, type OperatorSession } from "../api.ts";

export interface SliceLogState {
  name: string | null;
  lines: string[];
  error: string | null;
  loading: boolean;
}

/**
 * Live tail of a server-side log file (worker, debug, or unblock transcript).
 * Polls every 2s while active — the dashboard event stream only advances at
 * stage boundaries, so without polling a running session looks dead. Lines
 * reset on target change so a newly followed log never flashes the previous
 * tail. `target` must encode every fetch input; the fetcher always matches it.
 */
export function useTailedLog(
  target: string | null,
  active: boolean,
  fetchLines: () => Promise<{ name: string | null; lines: string[] }>,
): SliceLogState {
  const [name, setName] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(fetchLines);
  fetchRef.current = fetchLines;

  useEffect(() => {
    if (!target) {
      setLoading(false);
      setLines([]);
      setName(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    setLines([]);
    setName(null);
    const load = (quiet: boolean) => {
      fetchRef
        .current()
        .then((r) => {
          if (!live) return;
          setName(r.name);
          setLines(r.lines);
        })
        .catch((err) => {
          if (!live || quiet) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (live && !quiet) setLoading(false);
        });
    };
    load(false);
    const timer = active ? setInterval(() => load(true), 2000) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [target, active]);

  return { name, lines, error, loading };
}

/**
 * Live tail of a slice's current-generation worker log (`ompo logs` parity
 * for the browser). Without polling, a running slice looks dead for the
 * whole attempt — events only advance at stage boundaries (claim, handoff,
 * finish).
 */
export function useSliceLog(
  runId: string | null,
  sliceId: string | null,
  active: boolean,
  tail = 100,
): SliceLogState {
  const target = runId && sliceId ? `${runId}/${sliceId}/${tail}` : null;
  return useTailedLog(target, active, () => api.sliceLog(runId!, sliceId!, tail));
}

/** Live tail of one operator session (unblock round or debug session). */
export function useSessionLog(
  runId: string | null,
  session: OperatorSession | null,
  active: boolean,
  tail = 100,
): SliceLogState {
  const target =
    runId && session ? `${runId}/${session.kind}/${session.name}/${session.sliceId ?? ""}/${tail}` : null;
  return useTailedLog(target, active, () =>
    api.sessionLog(runId!, session!.name, {
      ...(session!.sliceId ? { slice: session!.sliceId } : {}),
      tail,
    }),
  );
}
