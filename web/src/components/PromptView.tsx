import type { SliceDetail, SliceSummary } from "../api.ts";

const HANDOFF_HINT = /prompt|handoff|generation|continu/i;
const PREVIEW_LINES = 12;

/**
 * Prompt tab: generation, model, prompt metadata, expandable prompt body,
 * and continuation/handoff information.
 */
export default function PromptView({
  selected,
  detail,
}: {
  selected: SliceSummary;
  detail: SliceDetail | null;
}) {
  const tail = detail?.promptTail ?? "";
  const lines = tail ? tail.split("\n") : [];
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const rest = lines.length > PREVIEW_LINES;
  const handoff = [...(detail?.recentEvents ?? []), ...(detail?.history ?? [])].filter((e) => HANDOFF_HINT.test(e));

  return (
    <div aria-label="Prompt">
      <h3>Metadata</h3>
      <dl className="omp-kv">
        <div>
          <dt>generation</dt>
          <dd>{selected.generation}</dd>
        </div>
        <div>
          <dt>attempt</dt>
          <dd>{selected.attempts}</dd>
        </div>
        <div>
          <dt>model</dt>
          <dd>{selected.agent ?? "—"}</dd>
        </div>
        <div>
          <dt>prompt</dt>
          <dd>{detail?.promptName ?? "—"}</dd>
        </div>
      </dl>

      {selected.generation > 0 ? (
        <p className="omp-hint">
          continuation g{selected.generation} of attempt {selected.attempts} — a context-cap handoff continued this work in a fresh session
        </p>
      ) : (
        <p className="omp-hint">first generation of attempt {selected.attempts} — no handoff continuation</p>
      )}

      <h3>Prompt{detail?.promptName ? ` · ${detail.promptName}` : ""}</h3>
      {!tail ? (
        <p className="omp-hint">no prompt artifact yet — prompt-N.md lands when the attempt spawns</p>
      ) : (
        <>
          <pre className="omp-code" style={{ whiteSpace: "pre-wrap" }}>{rest ? preview + "\n…" : preview}</pre>
          {rest && (
            <details>
              <summary>full prompt ({lines.length} lines)</summary>
              <div className="omp-detail-body">
                <pre className="omp-code" style={{ whiteSpace: "pre-wrap" }}>{tail}</pre>
              </div>
            </details>
          )}
        </>
      )}

      <h3>Continuation / handoff</h3>
      {handoff.length === 0 ? (
        <p className="omp-hint">no handoff events recorded</p>
      ) : (
        <ul className="omp-list">
          {handoff.map((e, i) => (
            <li key={i} className="omp-list-item">
              <span className="omp-list-reason">{e}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
