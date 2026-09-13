import { useEffect, useMemo, useRef, useState } from "react";
import type { SliceSummary } from "../api.ts";
import {
  DAG_NODE_H,
  DAG_NODE_W,
  layoutDag,
  type DagEdge,
} from "../lib/dag.ts";
import { shapeForStatus, type StatusShape } from "./icons.tsx";
import { toneForStatus } from "../lib/status.ts";

const TONE_STROKE: Record<string, string> = {
  cyan: "var(--omp-cyan)",
  green: "var(--omp-green)",
  amber: "var(--omp-amber)",
  red: "var(--omp-red)",
  muted: "var(--omp-border)",
};

const TITLE_CHARS = 26;

function truncate(title: string): string {
  return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title;
}
/** State glyph drawn as SVG shape (not a text char) beside the state word. */
function NodeGlyph({ shape, color }: { shape: StatusShape; color: string }) {
  return (
    <g transform="translate(11 49)" color={color} aria-hidden="true">
      {shape === "check" && (
        <path d="M1 5.4 3.8 8 9 2.4" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {shape === "dot" && <circle cx={5} cy={5} r={3} fill="currentColor" />}
      {shape === "cross" && (
        <path d="M2.2 2.2l5.6 5.6M7.8 2.2L2.2 7.8" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      )}
      {shape === "triangle" && (
        <path d="M5 1 9.4 9H0.6Z" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
      )}
      {shape === "ring" && <circle cx={5} cy={5} r={3} fill="none" stroke="currentColor" strokeWidth={1.4} />}
      {shape === "dash" && (
        <path d="M1.5 5h7" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      )}
      {shape === "point" && <circle cx={5} cy={5} r={1.7} fill="currentColor" />}
    </g>
  );
}

/** Orthogonal elbow path: horizontal out of the dep, vertical, horizontal in. */
function edgePath(e: DagEdge): string {
  const midX = (e.x1 + e.x2) / 2;
  if (e.y1 === e.y2) return `M ${e.x1} ${e.y1} H ${e.x2}`;
  return `M ${e.x1} ${e.y1} H ${midX} V ${e.y2} H ${e.x2}`;
}

function edgeStroke(e: DagEdge): string {
  if (e.unknown) return "var(--omp-amber)";
  if (e.inCycle) return "var(--omp-red)";
  return "var(--omp-faint)";
}

/**
 * Native-SVG dependency graph: one node per slice (id, title, state),
 * one edge per `Depends:` entry. No graph library — layered layout comes
 * from `lib/dag.ts`. Selecting a node selects the slice (Inspector).
 * Unknown deps render as dashed ghost nodes; cycles render with a visible
 * error banner and highlighted members instead of looping layout.
 */
export default function Dag({
  slices,
  selected,
  onSelect,
}: {
  slices: SliceSummary[];
  selected?: string | null;
  onSelect: (sliceId: string) => void;
}) {
  const layout = useMemo(() => layoutDag(slices), [slices]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(0);
  const [fit, setFit] = useState(true);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWrapW(w);
    });
    ro.observe(el);
    setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (slices.length === 0) {
    return (
      <section className="omp-panel" aria-label="Dependency graph">
        <h2>Dependency graph</h2>
        <p className="omp-hint">No slices yet.</p>
      </section>
    );
  }

  const needsFit = wrapW > 0 && layout.width > wrapW;
  const fitted = fit && needsFit;
  const fitPct = wrapW > 0 && layout.width > 0 ? Math.round((Math.min(wrapW, layout.width) / layout.width) * 100) : 100;

  return (
    <section className="omp-panel" aria-label="Dependency graph">
      <span className="omp-eyebrow">Graph</span>
      <h2>Dependency graph — {slices.length} slices</h2>
      {layout.unknownIds.length > 0 && (
        <p className="omp-warn" role="note">
          Unknown {layout.unknownIds.length === 1 ? "dependency" : "dependencies"} (not in roadmap — blocks like a
          pending dep): <code>{layout.unknownIds.join(", ")}</code>
        </p>
      )}
      {layout.cycleIds.length > 0 && (
        <p className="omp-error" role="alert">
          Dependency cycle involving: <code>{layout.cycleIds.join(", ")}</code> — drawn as declared; the scheduler
          makes no progress here.
        </p>
      )}
      <div className="omp-dag-bar" role="group" aria-label="Graph zoom">
        <span className="omp-hint">{fitted ? `Fitted to width (${fitPct}%) — full detail on 100%` : "Full size — fit removes horizontal scrolling"}</span>
        <button type="button" className="omp-btn" aria-pressed={fitted ? "true" : "false"} onClick={() => setFit(true)} disabled={fitted}>
          Fit width
        </button>
        <button type="button" className="omp-btn" aria-pressed={!fitted ? "true" : "false"} onClick={() => setFit(false)} disabled={!fitted}>
          100%
        </button>
      </div>
      <div className="omp-dag-scroll" ref={wrapRef} data-fitted={fitted ? "true" : "false"}>
        <svg
          width={fitted ? wrapW : layout.width}
          height={fitted && wrapW > 0 ? (layout.height * wrapW) / layout.width : layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="Roadmap dependency graph"
        >
          <defs>
            <marker
              id="omp-dag-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--omp-faint)" />
            </marker>
            <marker
              id="omp-dag-arrow-warn"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--omp-amber)" />
            </marker>
            <marker
              id="omp-dag-arrow-err"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--omp-red)" />
            </marker>
          </defs>
          {layout.edges.map((e) => (
            <path
              key={e.key}
              d={edgePath(e)}
              fill="none"
              stroke={edgeStroke(e)}
              strokeWidth={e.unknown || e.inCycle ? 1.8 : 1.4}
              strokeDasharray={e.unknown ? "6 4" : e.satisfied ? undefined : "2 3"}
              markerEnd={
                e.unknown
                  ? "url(#omp-dag-arrow-warn)"
                  : e.inCycle
                    ? "url(#omp-dag-arrow-err)"
                    : "url(#omp-dag-arrow)"
              }
              opacity={e.satisfied && !e.inCycle ? 0.55 : 1}
            >
              <title>{e.unknown ? `unknown dep ${e.key}` : e.key}</title>
            </path>
          ))}
          {layout.nodes.map((n) => {
            const isSel = selected === n.id && !n.ghost;
            const tone = n.ghost ? "amber" : toneForStatus(n.status);
            const shape: StatusShape = n.ghost ? "triangle" : shapeForStatus(n.status);
            const stateWords = n.ghost
              ? "unknown dep"
              : `${n.status}${n.blocked ? " · blocked" : ""}${n.ready ? " · ready" : ""}`;
            return (
              <g
                key={n.ghost ? `ghost:${n.id}` : n.id}
                className="omp-dag-node"
                data-selected={isSel ? "true" : "false"}
                data-ghost={n.ghost ? "true" : "false"}
                transform={`translate(${n.x} ${n.y})`}
                role={n.ghost ? undefined : "button"}
                tabIndex={n.ghost ? undefined : 0}
                aria-label={
                  n.ghost ? `unknown dependency ${n.id}` : `${n.id} ${n.title} — ${stateWords}${isSel ? " (selected)" : ""}`
                }
                aria-current={isSel ? "true" : undefined}
                onClick={n.ghost ? undefined : () => onSelect(n.id)}
                onKeyDown={
                  n.ghost
                    ? undefined
                    : (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect(n.id);
                        }
                      }
                }
              >
                <title>{n.ghost ? `unknown dependency ${n.id}` : `${n.id} — ${n.title}`}</title>
                <rect
                  width={DAG_NODE_W}
                  height={DAG_NODE_H}
                  rx={8}
                  fill={isSel ? "var(--omp-row-active)" : "var(--omp-panel-2)"}
                  stroke={
                    isSel
                      ? "var(--omp-focus)"
                      : n.inCycle
                        ? "var(--omp-red)"
                        : n.hasUnknownDep
                          ? "var(--omp-amber)"
                          : TONE_STROKE[tone]
                  }
                  strokeWidth={isSel || n.inCycle ? 2.4 : 1.4}
                  strokeDasharray={n.ghost ? "6 4" : n.inCycle ? "5 3" : undefined}
                />
                <text x={12} y={20} className="omp-dag-id">
                  {n.ghost ? `? ${n.id}` : n.id}
                </text>
                <text x={12} y={38} className="omp-dag-title">
                  {truncate(n.title)}
                </text>
                <NodeGlyph shape={shape} color={TONE_STROKE[tone] ?? "var(--omp-border)"} />
                <text
                  x={26}
                  y={56}
                  className="omp-dag-state"
                  data-tone={n.ghost ? "amber" : toneForStatus(n.status)}
                >
                  {stateWords}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="omp-hint">
        Edges follow <code>Depends:</code> — done/skipped deps satisfy (scheduler rule); dashed edges are unsatisfied,
        amber is unknown. Select a node to inspect it.
      </p>
    </section>
  );
}
