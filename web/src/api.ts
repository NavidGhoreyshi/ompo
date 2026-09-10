/** Typed client for the ompo dashboard API (docs/web-dashboard-architecture.md §3). */

export interface RunSummary {
  runId: string;
  createdAt: string;
  updatedAt: string;
  live: boolean;
  counts: { done: number; active: number; failed: number; skipped: number; blockedEnv: number; pending: number };
  workers: number;
  total: number;
  status: string;
  retries: number;
  handoffs: number;
  tokens: number | null;
  cost: number | null;
}

export interface SliceSummary {
  id: string;
  title: string;
  status: string;
  attempts: number;
  updatedAt: string;
  reason?: string;
  deps: string[];
  effort?: string;
  agent?: string;
  generation: number;
  verify: string[];
}

export type RunDetail = RunSummary & { slices: SliceSummary[] };

export interface TokenCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Cumulative per-session spend from `--mode json` usage envelopes
 * (see src/worker.ts usageForEvent). Optional fields stay absent when the
 * envelope omits them — the UI renders "—", never 0 or an estimate.
 * reasoningTokens is a sub-count of output, not an additive column.
 */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  cost?: TokenCost;
}

/**
 * One fresh-context generation's authoritative spend. `usage` is the full
 * envelope (sidecar first, per-generation events.jsonl fallback);
 * `tokensTotal` is the total-only handoffs.json fallback for ended
 * generations with no observed envelope. Both absent means unknown.
 */
export interface GenerationUsage {
  attempt: number;
  generation: number;
  usage?: TokenUsage;
  tokensTotal?: number;
  durationMs?: number;
}

export interface SliceDetail {
  sliceId: string;
  title: string;
  status: string;
  attempts: number;
  reason?: string;
  effort?: string;
  agent?: string;
  generation: number;
  verify: string[];
  deps: string[];
  reportSummary?: string;
  metrics?: { turns: number; tools: number; durationMs?: number; tokens?: TokenUsage };
  /** Per-generation spend, oldest first; [] when no generation ran yet. */
  generations?: GenerationUsage[];
  recentEvents: string[];
  history: string[];
  note?: string;
  verdictStep?: { name: string; exit: number | null; timedOut: boolean; tail: string };
  verdictSteps?: { name: string; exit: number | null; timedOut: boolean; tail: string }[];
  verdictPass?: boolean;
  review?: { approved: boolean; findings: string[]; notes?: string };
  reviewNotes?: string;
  promptTail?: string;
  promptName?: string;
  workerTail?: string;
  workerLogName?: string;
  artifacts: { report: boolean; verdict: boolean; review: boolean; workerLog: boolean; prompt: boolean };
  reportFull?: {
    filesChanged: string[];
    testsRun: string[];
    deferred: string[];
    done?: boolean;
    verificationNotes?: string;
    followUps: string[];
  };
}

 export interface AgentRow {
   id: string;
   lane: number;
   status: string;
   attempt: number;
   generation: number;
   agent?: string;
   effort?: string;
   lastLine: string;
   metrics?: { turns: number; tools: number; durationMs?: number; tokens?: TokenUsage };
 }

 export interface OperatorSession {
   name: string;
   kind: "unblock" | "debug";
   sliceId: string | null;
   targets: string[];
   status: "running" | "done";
   exit: number | null;
   timedOut: boolean;
   durationMs: number | null;
 }

export interface EffortStats {
  count: number;
  done: number;
  meanDurationMs: number | null;
  meanTurns: number | null;
  meanTools: number | null;
  meanTokens?: number | null;
}

/** Verbatim RunStats DTO from computeStats (src/stats.ts): 200 + partial body, never throws. */
export interface RunStats {
  runId: string;
  totals: Record<string, number>;
  passRate: number | null;
  attempts: { total: number; perSlice: Record<string, number> };
  meanAttempts?: number | null;
  meanTurns: number | null;
  meanTools: number | null;
  meanDurationMs: number | null;
  meanTokens?: number | null;
  tokensTotal?: number | null;
  handoffs?: number;
  byEffort: Record<string, EffortStats>;
  topFailingGates: { command: string; fails: number }[];
  modelFallbacks: Record<string, number>;
}

export interface RunEvent {
  seq: number;
  at: string;
  type: string;
  sliceId?: string;
  attempt?: number;
  detail?: string;
  reason?: string;
  exit?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  stats?: { turns: number; tools: number; tokens?: TokenUsage };
}

export type ControlKind = "retry" | "skip" | "park" | "kill" | "set-jobs" | "pause" | "resume";

/** POST …/control body: ControlIntent verbatim (arch §5). */
export interface ControlIntent {
  kind: ControlKind;
  sliceId?: string;
  jobs?: number;
  reason?: string;
}

/** Live run: the loop drains control_requested and the outcome arrives on the event stream. */
export interface ControlQueued {
  seq: number;
  kind: ControlKind;
  sliceId?: string;
  applied: "queued";
}

/** Quiescent run: cmdCtl parity — drained and applied synchronously. */
export interface ControlDirect {
  ok: boolean;
  message: string;
  applied: "direct";
}

export type ControlResult = ControlQueued | ControlDirect;
/** Detached resume loop spawned for a quiescent run (202). */
export interface ResumeResult {
  ok: boolean;
  applied: "spawned";
  pid: number;
  log: string;
}
/** One lint finding, verbatim from `lintRoadmap` (docs/web-dashboard-architecture.md §3). */
export interface LintFinding {
  level: "error" | "warn";
  slice?: string;
  code: string;
  message: string;
}

/** One proposed slice in the plan preview — the `PlanPreviewRow` shape from src/planPreview.ts. */
export interface PlanPreviewRow {
  id: string;
  title: string;
  effort: string;
  verifyCount: number;
  verify: string[];
  files: string[];
  deps: string[];
  errors: LintFinding[];
  warnings: LintFinding[];
}

/** GET /api/plan/preview envelope: preview plus the planner inputs surveyed. */
export interface PlanPreviewEnvelope {
  roadmapPath: string;
  exists: boolean;
  sourceHash?: string;
  status: "ready" | "warnings" | "blocked";
  summary: string;
  rows: PlanPreviewRow[];
  errors: LintFinding[];
  warnings: LintFinding[];
  surveyed: { path: string; mtimeMs: number }[];
}

export type PlanDecision = "accept" | "abort" | "edit";

export interface PlanDecisionResult {
  ok: boolean;
  decision: PlanDecision;
  status: PlanPreviewEnvelope["status"];
  summary: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* keep status text */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface EventsFilter {
  types?: string[];
  sliceId?: string;
}

export const api = {
  health: () => req<{ ok: boolean; version: string }>("/api/health"),
  runs: () => req<RunSummary[]>("/api/runs"),
  run: (runId: string) => req<RunDetail>(`/api/runs/${runId}`),
  slices: (runId: string) => req<SliceSummary[]>(`/api/runs/${runId}/slices`),
  slice: (runId: string, sliceId: string) =>
    req<SliceDetail>(`/api/runs/${runId}/slices/${sliceId}`),
  sliceLog: (runId: string, sliceId: string, tail = 50) =>
    req<{ name: string | null; lines: string[] }>(`/api/runs/${runId}/slices/${sliceId}/log?tail=${tail}`),
  sliceDiff: (runId: string, sliceId: string) =>
    req<Record<string, unknown>>(`/api/runs/${runId}/slices/${sliceId}/diff`),
  agents: (runId: string) => req<AgentRow[]>(`/api/runs/${runId}/agents`),
  sessions: (runId: string) => req<OperatorSession[]>(`/api/runs/${runId}/sessions`),
  sessionLog: (runId: string, name: string, opts?: { slice?: string; tail?: number }) => {
    const params = new URLSearchParams();
    if (opts?.slice) params.set("slice", opts.slice);
    params.set("tail", String(opts?.tail ?? 100));
    return req<{ name: string | null; lines: string[] }>(`/api/runs/${runId}/sessions/${name}/log?${params}`);
  },
  events: (runId: string, afterSeq = -1, limit = 200, filter?: EventsFilter) => {
    const params = new URLSearchParams({ afterSeq: String(afterSeq), limit: String(limit) });
    if (filter?.types?.length) params.set("types", filter.types.join(","));
    if (filter?.sliceId) params.set("sliceId", filter.sliceId);
    return req<{ events: RunEvent[]; offset: number }>(`/api/runs/${runId}/events?${params}`);
  },
  /** Canonical SSE live tail (arch §4): same RunEvent frames as `events` polling. Frames only signal *what* changed — state always refreshes via the read endpoints. */
  streamUrl: (runId: string, afterSeq = -1) => `/api/runs/${runId}/events/stream?afterSeq=${afterSeq}`,
  stats: (runId: string) => req<RunStats>(`/api/runs/${runId}/stats`),
  query: (runId: string, q: string) =>
    req<{ events: RunEvent[] }>(`/api/runs/${runId}/query?q=${encodeURIComponent(q)}`),
  replay: (runId: string) =>
    req<{ expected: Record<string, string>; actual: Record<string, string>; mismatches: string[]; events: number }>(
      `/api/runs/${runId}/replay`,
    ),
  control: (runId: string, body: ControlIntent) =>
    req<ControlResult>(`/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** Spawn a detached resume loop for a quiescent run (409 while live). */
  resume: (runId: string) =>
    req<ResumeResult>(`/api/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  planPreview: () => req<PlanPreviewEnvelope>("/api/plan/preview"),
  planRoadmap: () => req<{ path: string; markdown: string }>("/api/plan/roadmap"),
  planDecision: (decision: PlanDecision) =>
    req<PlanDecisionResult>("/api/plan/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }),
};
