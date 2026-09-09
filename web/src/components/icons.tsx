/**
 * Shared glyphs: simple inline SVGs that deliver a concept instead of text.
 *
 * Rule: status is symbol + word, never color or shape alone — every glyph
 * below renders `aria-hidden` next to a visible word (or sr-only text).
 * Shapes mirror the `symbolForStatus` families in StatusBadge.tsx so the
 * board, lanes, hero, trace, badges, and planner badges read as one system.
 * Colors come from the parent (`currentColor` + existing `data-tone` /
 * `data-lane` / `data-state` CSS) — this file owns shape only.
 */

export type StatusShape = "check" | "dot" | "cross" | "triangle" | "ring" | "dash" | "point";

export function shapeForStatus(status: string): StatusShape {
  switch (status) {
    case "done":
    case "passed":
    case "ready":
      return "check";
    case "failed":
    case "aborted":
    case "blocked":
      return "cross";
    case "blocked-env":
    case "warning":
    case "warnings":
      return "triangle";
    case "pending":
      return "ring";
    case "skipped":
      return "dash";
    default:
      return "point";
  }
}

function ShapePaths({ shape }: { shape: StatusShape }) {
  switch (shape) {
    case "check":
      return (
        <path
          d="M2.2 6.4 5 8.8 9.8 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "dot":
      return <circle cx={6} cy={6} r={3.6} fill="currentColor" />;
    case "cross":
      return (
        <path
          d="M3 3l6 6M9 3L3 9"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
        />
      );
    case "triangle":
      return (
        <path
          d="M6 1.8 10.8 10H1.2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinejoin="round"
        />
      );
    case "ring":
      return <circle cx={6} cy={6} r={3.6} fill="none" stroke="currentColor" strokeWidth={1.7} />;
    case "dash":
      return (
        <path d="M2.5 6h7" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" />
      );
    case "point":
      return <circle cx={6} cy={6} r={2} fill="currentColor" />;
  }
}

/** Status glyph from a domain status string. Parent supplies color. */
export function StatusSymbol({ status }: { status: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" data-shape={shapeForStatus(status)}>
      <ShapePaths shape={shapeForStatus(status)} />
    </svg>
  );
}

/** Execution-trace glyph from a lifecycle state. */
export function TraceSymbol({ state }: { state: string }) {
  const status = state === "done" ? "done" : state === "active" ? "running" : state === "failed" ? "failed" : "pending";
  return <StatusSymbol status={status} />;
}

export type LaneShape = "dot" | "check" | "diamond" | "triangle" | "ring";

export function shapeForLane(lane: string): LaneShape {
  switch (lane) {
    case "worker":
      return "dot";
    case "verify":
      return "check";
    case "review":
      return "diamond";
    case "control":
      return "triangle";
    default:
      return "ring";
  }
}

/** Lane glyph for activity filter chips and rows. Parent supplies color. */
export function LaneSymbol({ lane }: { lane: string }) {
  const shape = shapeForLane(lane);
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" data-lane-shape={shape}>
      {shape === "dot" && <circle cx={6} cy={6} r={3.6} fill="currentColor" />}
      {shape === "check" && (
        <path
          d="M2.2 6.4 5 8.8 9.8 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {shape === "diamond" && <path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" fill="currentColor" />}
      {shape === "triangle" && (
        <path
          d="M6 1.8 10.8 10H1.2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinejoin="round"
        />
      )}
      {shape === "ring" && (
        <circle cx={6} cy={6} r={3.6} fill="none" stroke="currentColor" strokeWidth={1.7} />
      )}
    </svg>
  );
}

export function LockSymbol() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
