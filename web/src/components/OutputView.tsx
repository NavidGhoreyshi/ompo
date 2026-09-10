import type { SliceDetail, SliceSummary } from "../api.ts";
import { formatDurationMs, formatTokens } from "../lib/format.ts";
import StatusBadge from "./StatusBadge.tsx";

/**
 * Output tab: human-readable execution summary. Status, attempt, generation,
 * authoritative duration/tokens, report summary, latest signal, handoff
 * history. Raw logs and JSON stay out — they live in Events / Raw detail.
 */
export default function OutputView({
  selected,
  detail,
}: {
  selected: SliceSummary;
  detail: SliceDetail | null;
}) {
  const d = detail;
  const metrics = d?.metrics;
  const tokens = metrics?.tokens;
  const history = [...(d?.recentEvents ?? []), ...(d?.history ?? [])];

  return (
    <div aria-label="Output">
      <h3>Last run</h3>
      <dl className="omp-kv">
        <div>
          <dt>status</dt>
          <dd><StatusBadge status={selected.status} /></dd>
        </div>
        <div>
          <dt>attempt</dt>
          <dd>{selected.attempts}</dd>
        </div>
        <div>
          <dt>generation</dt>
          <dd>{selected.generation}{selected.generation > 0 ? <span className="omp-hint"> · handoff chain</span> : ""}</dd>
        </div>
        <div>
          <dt>duration</dt>
          <dd>{formatDurationMs(metrics?.durationMs)}</dd>
        </div>
        <div>
          <dt>tokens</dt>
          <dd>
            {tokens ? (
              <span title={`in ${tokens.input} / out ${tokens.output}`}>
                {formatTokens(tokens.total)} <span className="omp-hint">· in {formatTokens(tokens.input)} / out {formatTokens(tokens.output)}</span>
              </span>
            ) : (
              "—"
            )}
          </dd>
        </div>
        {metrics && (
          <div>
            <dt>activity</dt>
            <dd>{metrics.turns} turns <span className="omp-hint">· {metrics.tools} tools</span></dd>
          </div>
        )}
        {selected.agent && (
          <div>
            <dt>agent</dt>
            <dd>{selected.agent}</dd>
          </div>
        )}
      </dl>

      <h3>Summary</h3>
      {d?.reportSummary ? (
        <p className="omp-summary">{d.reportSummary}</p>
      ) : (
        <p className="omp-hint">
          {selected.status === "running" || selected.status === "verifying"
            ? "no report yet — worker is active; follow live output on the Log tab"
            : selected.status === "pending" || selected.status === "blocked" || selected.status === "blocked-env"
              ? "no output yet — worker hasn't started"
              : "no output yet"}
        </p>
      )}

      {d?.verdictStep && (
        <>
          <h3>Outcome signal</h3>
          <p className="omp-error" style={{ margin: "4px 0" }}>
            ✕ gate {d.verdictStep.name} exit={String(d.verdictStep.exit)} timedOut={String(d.verdictStep.timedOut)}
          </p>
          <p className="omp-hint">Failure detail lives in the Verify tab.</p>
        </>
      )}

      {d?.note && (
        <>
          <h3>Latest signal</h3>
          <p className="omp-hint" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "4px 0" }}>{d.note}</p>
        </>
      )}

      <h3>Handoff history</h3>
      {history.length === 0 ? (
        <p className="omp-hint">no events yet</p>
      ) : (
        <ul className="omp-list">
          {history.map((e, i) => (
            <li key={i} className="omp-list-item">
              <span className="omp-list-reason">{e}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
