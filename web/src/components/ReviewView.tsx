import type { SliceDetail } from "../api.ts";
import StatusBadge from "./StatusBadge.tsx";

/** Fix-lane signal inside formatted event lines (review/debug/handoff flow). */
const FIX_LANE = /review|debug|handoff|retr|fix/i;

/**
 * Review tab: reviewer verdict, severity-carrying findings, touched files,
 * review notes, and fix-lane history. Touched files come from the worker
 * report (same forensics source as the Diff tab).
 */
export default function ReviewView({ detail }: { detail: SliceDetail | null }) {
  const review = detail?.review;
  const touched = detail?.reportFull?.filesChanged ?? [];
  const lane = [...(detail?.recentEvents ?? []), ...(detail?.history ?? [])].filter((e) => FIX_LANE.test(e));

  return (
    <div aria-label="Review">
      <h3>Reviewer verdict</h3>
      {!review ? (
        <p className="omp-hint">no review yet — the reviewer audits after merge</p>
      ) : (
        <>
          <p style={{ margin: "4px 0" }}>
            <StatusBadge status={review.approved ? "passed" : "failed"} />{" "}
            <strong>{review.approved ? "approved" : "rejected — heads the next attempt first"}</strong>
          </p>
          {review.findings.length === 0 ? (
            <p className="omp-hint">no findings recorded</p>
          ) : (
            <ul className="omp-list">
              {review.findings.map((f, i) => (
                <li key={i} className="omp-list-item">
                  <span className="omp-list-reason">{f}</span>
                </li>
              ))}
            </ul>
          )}
          {review.notes && (
            <p style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{review.notes}</p>
          )}
        </>
      )}

      {detail?.reviewNotes && (
        <>
          <h3>Prior rejection (next-attempt input)</h3>
          <p style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{detail.reviewNotes}</p>
        </>
      )}

      <h3>Touched files</h3>
      {touched.length === 0 ? (
        <p className="omp-hint">no file list yet</p>
      ) : (
        <ul className="omp-list">
          {touched.map((f) => (
            <li key={f} className="omp-list-item"><code>{f}</code></li>
          ))}
        </ul>
      )}

      <h3>Fix-lane history</h3>
      {lane.length === 0 ? (
        <p className="omp-hint">no review / debug / handoff events yet</p>
      ) : (
        <ul className="omp-list">
          {lane.map((e, i) => (
            <li key={i} className="omp-list-item">
              <span className="omp-list-reason">{e}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
