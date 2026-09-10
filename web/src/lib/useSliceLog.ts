import { useEffect, useState } from "react";
import { api } from "../api.ts";

export interface SliceLogState {
  name: string | null;
  lines: string[];
  error: string | null;
  loading: boolean;
}

/**
 * Live tail of a slice's current-generation worker log (`ompo logs` parity
 * for the browser). Polls every 2s while the slice is active — the dashboard
 * event stream only advances at stage boundaries (claim, handoff, finish),
 * so without polling a running slice looks dead for the whole attempt.
 * Lines reset on slice change so a newly followed slice never flashes the
 * previous slice's tail.
 */
export function useSliceLog(
  runId: string | null,
  sliceId: string | null,
  active: boolean,
  tail = 100,
): SliceLogState {
  const [name, setName] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runId || !sliceId) {
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
      api
        .sliceLog(runId, sliceId, tail)
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
  }, [runId, sliceId, active, tail]);

  return { name, lines, error, loading };
}
