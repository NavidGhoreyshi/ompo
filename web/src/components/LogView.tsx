import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

/**
 * Log tab: live tail of the current generation's worker log (`ompo logs`
 * parity for the browser). Polls every 2s while the slice is active — the
 * dashboard event stream only advances at stage boundaries (claim, handoff,
 * finish), so without this tab a running slice looks dead for the whole
 * attempt. The TUI needs no such tab: it streams the worker to the terminal.
 */
export default function LogView({
  runId,
  sliceId,
  active,
}: {
  runId: string;
  sliceId: string;
  /** True while the slice is running/verifying: poll for new lines. */
  active: boolean;
}) {
  const [name, setName] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const load = (quiet: boolean) => {
      api
        .sliceLog(runId, sliceId, 100)
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
  }, [runId, sliceId, active]);

  // Tail-following: stay pinned to the newest line as polls land.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div aria-label="Log">
      <h3>
        Worker log{" "}
        <span className="omp-hint">
          · {name ?? "no log yet"} · {active ? "live (2s poll)" : "settled"}
        </span>
      </h3>
      {loading && <p className="omp-hint">loading log…</p>}
      {!loading && error && (
        <p className="omp-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && lines.length === 0 && (
        <p className="omp-hint">no worker lines yet — output appears once the worker starts writing</p>
      )}
      {!loading && !error && lines.length > 0 && (
        <pre ref={preRef} className="omp-code" style={{ maxHeight: 320, overflow: "auto" }}>
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
