/** Typed client for the ompo dashboard API (docs/web-dashboard-architecture.md §3). */

export interface RunSummary {
  runId: string;
  createdAt: string;
  updatedAt: string;
  live: boolean;
  counts: { done: number; active: number; failed: number; skipped: number; blockedEnv: number; pending: number };
}

export interface SliceSummary {
  id: string;
  title: string;
  status: string;
  attempts: number;
  updatedAt: string;
  reason?: string;
  deps: string[];
}

export type RunDetail = RunSummary & { slices: SliceSummary[] };

export interface RunEvent {
  seq: number;
  at: string;
  type: string;
  sliceId?: string;
  attempt?: number;
  detail?: string;
  reason?: string;
}

export type ControlKind = "retry" | "skip" | "park" | "kill" | "set-jobs" | "pause" | "resume";

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

export const api = {
  health: () => req<{ ok: boolean; version: string }>("/api/health"),
  runs: () => req<RunSummary[]>("/api/runs"),
  run: (runId: string) => req<RunDetail>(`/api/runs/${runId}`),
  slice: (runId: string, sliceId: string) =>
    req<Record<string, unknown>>(`/api/runs/${runId}/slices/${sliceId}`),
  sliceLog: (runId: string, sliceId: string, tail = 50) =>
    req<{ name: string | null; lines: string[] }>(`/api/runs/${runId}/slices/${sliceId}/log?tail=${tail}`),
  sliceDiff: (runId: string, sliceId: string) =>
    req<Record<string, unknown>>(`/api/runs/${runId}/slices/${sliceId}/diff`),
  events: (runId: string, afterSeq = -1, limit = 200) =>
    req<{ events: RunEvent[]; offset: number }>(`/api/runs/${runId}/events?afterSeq=${afterSeq}&limit=${limit}`),
  stats: (runId: string) => req<Record<string, unknown>>(`/api/runs/${runId}/stats`),
  control: (runId: string, body: Record<string, unknown>) =>
    req<Record<string, unknown>>(`/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
};
