import type { SliceDetail } from "../api.ts";
import { StatusSymbol } from "./icons.tsx";
import StatusBadge from "./StatusBadge.tsx";

/**
 * Verify tab: declared gates vs executed verdict steps. Each gate is a
 * structured row (gate, status, exit/timeout) with failure tails expandable
 * in place — earlier passing gates stay visible as context for the failure.
 */
export default function VerifyView({ detail }: { detail: SliceDetail | null }) {
  const steps = detail?.verdictSteps ?? [];
  const executed = new Set(steps.map((s) => s.name));
  const pendingGates = (detail?.verify ?? []).filter((g) => !executed.has(g));
  const failedIdx = steps.findIndex((s) => s.exit !== 0);

  return (
    <div aria-label="Verify">
      <h3>
        Gates
        {detail?.verdictPass === true ? " · pass" : detail?.verdictPass === false ? " · fail" : ""}
      </h3>
      {detail?.verdictPass === true && <p className="omp-hint">all gates passed</p>}
      {detail?.verdictPass === false && failedIdx >= 0 && (
        <p className="omp-error" style={{ margin: "4px 0" }}>
          <span aria-hidden="true" className="omp-inline-glyph" data-tone="red">
            <StatusSymbol status="failed" />
          </span>{" "}
          {steps[failedIdx]!.name} failed{failedIdx > 0 ? ` after ${failedIdx} passing gate${failedIdx === 1 ? "" : "s"}` : " on the first gate"}
        </p>
      )}
      {steps.length === 0 && pendingGates.length === 0 && (
        <p className="omp-hint">no verdict yet — gates run after the worker finishes</p>
      )}
      {steps.length > 0 && (
        <div className="omp-table-wrap">
          <table className="omp-table">
            <thead>
              <tr>
                <th scope="col">Gate</th>
                <th scope="col">Status</th>
                <th scope="col">Exit</th>
                <th scope="col">Timed out</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <tr key={s.name}>
                  <td><code>{s.name}</code></td>
                  <td>
                    <StatusBadge status={s.exit === 0 ? "passed" : "failed"} />
                  </td>
                  <td>{String(s.exit)}</td>
                  <td>
                    {s.timedOut ? (
                      <span className="omp-inline-glyph" data-tone="red" title="timed out">
                        <span aria-hidden="true" className="omp-glyph">
                          <StatusSymbol status="failed" />
                        </span>
                        <span className="omp-sr-only">timed out</span>
                      </span>
                    ) : (
                      <span className="omp-inline-glyph" data-tone="muted" title="did not time out">
                        <span aria-hidden="true" className="omp-glyph">
                          <StatusSymbol status="skipped" />
                        </span>
                        <span className="omp-sr-only">no</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pendingGates.length > 0 && (
        <>
          <h3>Not yet run</h3>
          <ul className="omp-list">
            {pendingGates.map((g) => (
              <li key={g} className="omp-list-item">
                <code>{g}</code>
                <span className="omp-list-reason">declared gate — no verdict step yet</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {steps.filter((s) => s.exit !== 0 && s.tail).map((s) => (
        <details key={s.name} open>
          <summary>failure: {s.name}</summary>
          <div className="omp-detail-body">
            <pre className="omp-code" style={{ whiteSpace: "pre-wrap" }}>{s.tail}</pre>
          </div>
        </details>
      ))}
      {steps.filter((s) => s.exit === 0 && s.tail).map((s) => (
        <details key={s.name}>
          <summary>output: {s.name}</summary>
          <div className="omp-detail-body">
            <pre className="omp-code" style={{ whiteSpace: "pre-wrap" }}>{s.tail}</pre>
          </div>
        </details>
      ))}
    </div>
  );
}
