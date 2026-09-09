import { useEffect, useState } from "react";
import { api, type SliceDetail } from "../api.ts";

interface SliceDiff {
  branch: string;
  base: string | null;
  stat: string;
  diff: string;
  note: string;
}

function isDiff(o: unknown): o is SliceDiff {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return typeof r.branch === "string" && typeof r.stat === "string" && typeof r.diff === "string" && typeof r.note === "string";
}

/** Split a unified diff into per-file sections, each with header + hunks. Pure. */
export function splitDiffFiles(diff: string): { header: string; hunks: string[] }[] {
  const files: { header: string; hunks: string[] }[] = [];
  const chunks = diff.split(/^diff --git /m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const hunkStarts: number[] = [];
    lines.forEach((l, i) => {
      if (l.startsWith("@@")) hunkStarts.push(i);
    });
    if (hunkStarts.length === 0) {
      files.push({ header: `diff --git ${lines[0] ?? ""}`, hunks: [] });
      continue;
    }
    const first = hunkStarts[0]!;
    const header = `diff --git ${lines.slice(0, first).join("\n")}`;
    const hunks = hunkStarts.map((s, k) => lines.slice(s, hunkStarts[k + 1] ?? lines.length).join("\n"));
    files.push({ header, hunks });
  }
  return files;
}

/** One diff line with terminal-style coloring (no external highlighter). */
function DiffLine({ line }: { line: string }) {
  let color: string | undefined;
  let weight: number | undefined;
  if (line.startsWith("@@")) {
    color = "var(--omp-cyan)";
    weight = 700;
  } else if (line.startsWith("+") && !line.startsWith("+++")) {
    color = "var(--omp-green)";
  } else if (line.startsWith("-") && !line.startsWith("---")) {
    color = "var(--omp-red)";
  } else if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) {
    color = "var(--omp-muted)";
    weight = 700;
  }
  return (
    <span style={color ? { color, fontWeight: weight } : undefined}>
      {line || " "}
      {"\n"}
    </span>
  );
}

/**
 * Diff tab: reported files/tests/deferrals (forensics semantics) plus the
 * branch-vs-merge-base unified diff as expandable, highlighted hunks.
 */
export default function DiffView({
  runId,
  sliceId,
  detail,
}: {
  runId: string;
  sliceId: string;
  detail: SliceDetail | null;
}) {
  const [diff, setDiff] = useState<SliceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .sliceDiff(runId, sliceId)
      .then((r) => {
        if (!live) return;
        setDiff(isDiff(r) ? r : null);
        if (!isDiff(r)) setError("unexpected diff payload");
      })
      .catch((err) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [runId, sliceId]);

  const full = detail?.reportFull;
  const files = diff?.diff ? splitDiffFiles(diff.diff) : [];
  const hunkCount = files.reduce((n, f) => n + f.hunks.length, 0);

  return (
    <div aria-label="Diff">
      <h3>Files changed</h3>
      {!full || full.filesChanged.length === 0 ? (
        <p className="omp-hint">no file list yet — the worker reports filesChanged on finish</p>
      ) : (
        <ul className="omp-list">
          {full.filesChanged.map((f) => (
            <li key={f} className="omp-list-item"><code>± {f}</code></li>
          ))}
        </ul>
      )}

      <h3>Tests + deferrals</h3>
      {!full || (full.testsRun.length === 0 && full.deferred.length === 0 && full.followUps.length === 0 && !full.verificationNotes) ? (
        <p className="omp-hint">nothing recorded</p>
      ) : (
        <ul className="omp-list">
          {full.testsRun.map((t) => (
            <li key={t} className="omp-list-item"><span>✓ {t}</span></li>
          ))}
          {full.deferred.map((x) => (
            <li key={x} className="omp-list-item"><span className="omp-list-reason">… deferred: {x}</span></li>
          ))}
          {full.followUps.map((x) => (
            <li key={x} className="omp-list-item"><span className="omp-list-reason">→ follow-up: {x}</span></li>
          ))}
          {full.verificationNotes && (
            <li className="omp-list-item"><span className="omp-list-reason">notes: {full.verificationNotes}</span></li>
          )}
        </ul>
      )}

      <h3>Branch diff{hunkCount > 0 ? ` — ${hunkCount} hunk${hunkCount === 1 ? "" : "s"}` : ""}</h3>
      {loading && <p className="omp-hint">loading diff…</p>}
      {!loading && error && <p className="omp-error" role="alert">diff unavailable: {error}</p>}
      {!loading && !error && diff && (
        <>
          <p className="omp-hint">
            {diff.branch}{diff.base ? ` vs ${diff.base.slice(0, 12)}` : ""}{diff.note ? ` · ${diff.note}` : ""}
          </p>
          {diff.stat && (
            <pre className="omp-code" style={{ whiteSpace: "pre-wrap" }}>{diff.stat}</pre>
          )}
          {!diff.diff && <p className="omp-hint">{diff.note || "no changes"}</p>}
          {files.map((f, i) => (
            <details key={i} open={i === 0}>
              <summary>{f.header.split("\n")[0]}{f.hunks.length > 0 ? ` — ${f.hunks.length} hunk${f.hunks.length === 1 ? "" : "s"}` : ""}</summary>
              <div className="omp-detail-body">
                {f.header.split("\n").slice(1).join("\n").trim() && (
                  <pre className="omp-code">{f.header.split("\n").slice(1).join("\n")}</pre>
                )}
                {f.hunks.map((h, j) => (
                  <details key={j} open={i === 0 && j === 0}>
                    <summary>{h.split("\n")[0]}</summary>
                    <pre className="omp-code">
                      {h.split("\n").slice(1).map((l, k) => (
                        <DiffLine key={k} line={l} />
                      ))}
                    </pre>
                  </details>
                ))}
              </div>
            </details>
          ))}
        </>
      )}
    </div>
  );
}
