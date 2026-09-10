import { useEffect, useRef } from "react";
import type { OperatorSession } from "../api.ts";
import { formatDurationMs } from "../lib/format.ts";
import { useSessionLog } from "../lib/useSliceLog.ts";

/**
 * Operator sessions: the loop's own agent sessions (end-of-run unblock
 * rounds, per-slice debug sessions) with the same live-tail treatment as
 * slice workers. Sessions stream their progress transcript to disk as they
 * render (worker parity), so a running entry polls live; a finished entry
 * shows the exit footer. Renders nothing when the run has no sessions —
 * like the attention banner, it appears only when there is something to see.
 */
export default function SessionsPanel({
  runId,
  sessions,
}: {
  runId: string | null;
  sessions: OperatorSession[];
}) {
  if (sessions.length === 0) return null;
  const running = sessions.filter((s) => s.status === "running").length;
  return (
    <section className="omp-sessions" aria-label={`Operator sessions — ${sessions.length}`}>
      <div className="omp-sessions-head">
        <span className="omp-section-label">Operator sessions</span>
        <span className="omp-hint">
          {running > 0 ? `${running} running` : "all settled"} · {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
      </div>
      {sessions.map((s) => (
        <SessionCard key={`${s.kind}:${s.name}:${s.sliceId ?? ""}`} runId={runId} session={s} />
      ))}
    </section>
  );
}

function sessionLabel(s: OperatorSession): string {
  if (s.kind === "unblock") {
    return s.targets.length > 0 ? `unblock ${s.targets.join(", ")}` : "unblock";
  }
  return `${s.name} · ${s.sliceId ?? "?"}`;
}

function SessionCard({ runId, session }: { runId: string | null; session: OperatorSession }) {
  const active = session.status === "running";
  const { lines, error, loading } = useSessionLog(runId, session, active, 100);
  const preRef = useRef<HTMLPreElement | null>(null);

  // Tail-following: stay pinned to the newest line as polls land.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const outcome = session.timedOut
    ? "timed out"
    : session.exit === null
      ? null
      : session.exit === 0
        ? "exit 0"
        : `exit ${session.exit}`;
  const outcomeTitle =
    session.timedOut || session.exit === null
      ? undefined
      : `exit=${session.exit} durationMs=${session.durationMs ?? "?"}`;

  return (
    <article className="omp-session" data-live={active ? "true" : "false"} aria-label={`Session ${sessionLabel(session)}`}>
      <div className="omp-livefeed-head">
        <span aria-hidden="true" className="omp-livefeed-dot" />
        <code className="omp-livefeed-id">{session.name}</code>
        <span className="omp-ellipsis omp-livefeed-title" title={sessionLabel(session)}>
          {sessionLabel(session)}
        </span>
        <span className="omp-hint">
          {active ? "running · live (2s poll)" : "settled"}
          {outcome ? ` · ${outcome}` : ""}
          {session.durationMs !== null ? ` · ${formatDurationMs(session.durationMs)}` : ""}
        </span>
      </div>
      {loading && <p className="omp-hint">loading session log…</p>}
      {!loading && error && (
        <p className="omp-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && lines.length === 0 && (
        <p className="omp-hint">{active ? "session started — lines appear once it starts writing" : "no session lines recorded"}</p>
      )}
      {!loading && !error && lines.length > 0 && (
        <pre
          ref={preRef}
          className="omp-code omp-session-log"
          aria-label={`Session log tail — ${session.name}`}
          tabIndex={0}
          title={outcomeTitle}
        >
          {lines.join("\n")}
        </pre>
      )}
    </article>
  );
}
