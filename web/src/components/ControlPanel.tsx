import { useEffect, useMemo, useState } from "react";
import { Check, Minus, Pause, Play, Plus, RotateCcw, SkipForward, Square, type LucideIcon } from "lucide-react";
import {
  api,
  type ControlIntent,
  type ControlKind,
  type RunEvent,
  type SliceSummary,
} from "../api.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

/**
 * Contextual control: prefilled from the current selection (inspector or
 * roadmap row), not a permanent giant menu. Same ControlIntent contract as
 * `ompo ctl` (arch §5) — this panel creates no new semantics, it only calls
 * the same control API behind contextual buttons.
 *
 * Safety: destructive slice actions (kill, skip) arm a two-step inline
 * confirm that still calls the same endpoint. Outcome state (pending,
 * applied, rejected) always derives from actual events — a queued intent is
 * never reported as success before the orchestrator appends
 * control_applied / control_rejected.
 */

type SliceKind = "retry" | "skip" | "park" | "kill";
type RunKind = "pause" | "resume";

const SLICE_ACTIONS: readonly { kind: SliceKind; label: string; hint: string; icon: LucideIcon }[] = [
  { kind: "retry", label: "Retry", hint: "re-queue the slice with one more attempt", icon: RotateCcw },
  { kind: "skip", label: "Skip", hint: "mark skipped — needs confirmation", icon: SkipForward },
  { kind: "park", label: "Park", hint: "park with a reason (required)", icon: Pause },
  { kind: "kill", label: "Kill", hint: "kill the slice — needs confirmation", icon: Square },
];

/** Destructive slice actions arm an inline confirm before the same API call. */
const DESTRUCTIVE: Record<SliceKind, true> = { skip: true, kill: true };

interface PendingIntent {
  seq: number;
  kind: ControlKind;
  sliceId?: string;
  jobs?: number;
}

interface DirectOutcome {
  ok: boolean;
  message: string;
}

function outcomeMatches(e: RunEvent, pending: PendingIntent): boolean {
  if (e.seq <= pending.seq) return false;
  if (e.type !== "control_applied" && e.type !== "control_rejected") return false;
  if ((e.sliceId ?? undefined) !== pending.sliceId) return false;
  // Applied/rejected details are `${kind}: ${message}` (control.ts applyIntent).
  if (typeof e.detail === "string" && e.detail.length > 0) {
    if (e.detail === pending.kind) return true;
    if (e.detail.startsWith(`${pending.kind}:`)) return true;
    // Fall through to scope+recency matching when the payload shape drifts.
  }
  return true;
}

export default function ControlPanel({
  runId,
  slices,
  initialSliceId,
  onDone,
  events = [],
  live,
}: {
  runId: string;
  slices: SliceSummary[];
  initialSliceId?: string | null;
  onDone: () => void;
  /** SSE-fed event tail (App-owned); the sole source for pending/applied/rejected state. */
  events?: RunEvent[];
  /** Live flag for the queued-vs-direct hint; omitted renders neither claim. */
  live?: boolean;
}) {
  const [sliceId, setSliceId] = useState(initialSliceId ?? "");
  const [jobs, setJobs] = useState("4");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingIntent | null>(null);
  const [direct, setDirect] = useState<DirectOutcome | null>(null);
  const [confirmKind, setConfirmKind] = useState<SliceKind | null>(null);

  // Follow the inspector selection: locked when a context slice is provided.
  useEffect(() => {
    if (initialSliceId !== undefined) setSliceId(initialSliceId ?? "");
  }, [initialSliceId]);
  const locked = initialSliceId !== undefined;
  const target = locked ? (initialSliceId ?? "") : sliceId;

  // A new run retires in-flight UI state; events belong to the old run.
  useEffect(() => {
    setPending(null);
    setDirect(null);
    setRequestError(null);
    setConfirmKind(null);
  }, [runId]);

  // A new selection disarms any armed confirm; the pending intent (if any)
  // stays visible until its orchestrator outcome lands in the event tail.
  useEffect(() => {
    setConfirmKind(null);
  }, [target]);

  async function sendIntent(body: ControlIntent, pendingJobs?: number) {
    setBusy(true);
    setRequestError(null);
    setDirect(null);
    try {
      const res = await api.control(runId, body);
      if (res.applied === "queued") {
        setPending({
          seq: res.seq,
          kind: res.kind,
          ...(res.sliceId ? { sliceId: res.sliceId } : {}),
          ...(pendingJobs !== undefined ? { jobs: pendingJobs } : {}),
        });
      } else {
        setPending(null);
        setDirect({ ok: res.ok, message: res.message });
      }
      onDone();
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function sendSlice(kind: SliceKind) {
    if (!target) return;
    if (kind === "park" && !reason.trim()) {
      setRequestError("park needs a reason (what to fix before resume)");
      return;
    }
    setConfirmKind(null);
    const body: ControlIntent = { kind };
    body.sliceId = target;
    if (reason.trim()) body.reason = reason.trim();
    void sendIntent(body);
  }

  function clickSlice(kind: SliceKind) {
    if (DESTRUCTIVE[kind] && confirmKind !== kind) {
      setConfirmKind(kind);
      return;
    }
    sendSlice(kind);
  }

  function sendRun(kind: RunKind) {
    const body: ControlIntent = { kind };
    if (reason.trim()) body.reason = reason.trim();
    void sendIntent(body);
  }

  function sendJobs(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 32) {
      setRequestError(`set-jobs needs an integer jobs 1..32 (got ${value})`);
      return;
    }
    setJobs(String(value));
    const body: ControlIntent = { kind: "set-jobs", jobs: value };
    if (reason.trim()) body.reason = reason.trim();
    void sendIntent(body, value);
  }

  function stepJobs(delta: -1 | 1) {
    const base = Number.parseInt(jobs, 10);
    const current = Number.isInteger(base) ? base : 4;
    const next = Math.min(32, Math.max(1, current + delta));
    sendJobs(next);
  }

  // Orchestrator-confirmed outcome for the queued intent, from actual events.
  const outcome = useMemo(() => {
    if (!pending) return null;
    let best: RunEvent | null = null;
    for (const e of events) {
      if (!outcomeMatches(e, pending)) continue;
      if (!best || e.seq < best.seq) best = e;
    }
    return best;
  }, [events, pending]);

  // Recent control traffic in scope: the selected slice plus run-level
  // (pause/resume/set-jobs carry no sliceId). Newest first, capped.
  const recentControl = useMemo(() => {
    const rows = events.filter(
      (e) =>
        (e.type === "control_requested" ||
          e.type === "control_applied" ||
          e.type === "control_rejected") &&
        (e.sliceId === undefined || (target !== "" && e.sliceId === target)),
    );
    return rows.slice(-4).reverse();
  }, [events, target]);

  const parkBlocked = reason.trim().length === 0;
  const sliceBlocked = target === "";

  return (
    <section aria-label="Control">
      <div className="omp-control-group" role="group" aria-label={`Slice actions${target ? ` for ${target}` : ""}`}>
        <span className="omp-control-label">
          Slice {locked ? <code>{target || "— select a slice —"}</code> : null}
        </span>
        {!locked && (
          <Select value={sliceId} onValueChange={setSliceId}>
            <SelectTrigger size="sm" className="w-40" aria-label="Target slice">
              <SelectValue placeholder="— slice —" />
            </SelectTrigger>
            <SelectContent>
              {slices.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  <span className="font-mono text-xs">{s.id}</span>
                  <span className="text-muted-foreground">[{s.status}]</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {SLICE_ACTIONS.map((a) => {
          const armed = confirmKind === a.kind;
          const Icon = a.icon;
          return (
            <Button
              key={a.kind}
              size="sm"
              variant={armed ? "destructive" : a.kind === "retry" ? "default" : "outline"}
              disabled={busy || sliceBlocked || (a.kind === "park" && parkBlocked)}
              title={
                sliceBlocked
                  ? "select a slice first"
                  : a.kind === "park" && parkBlocked
                    ? "park needs a reason — type one first"
                    : a.hint
              }
              onClick={() => clickSlice(a.kind)}
            >
              <Icon aria-hidden="true" />
              {armed ? `Confirm ${a.kind}` : a.label}
            </Button>
          );
        })}
        {confirmKind && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label="Cancel confirmation"
            onClick={() => setConfirmKind(null)}
          >
            Cancel
          </Button>
        )}
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason — required for park, optional otherwise"
          size={32}
          aria-label="Control reason"
          className="flex-1"
        />
      </div>

      <div className="omp-control-group" role="group" aria-label="Run actions">
        <span className="omp-control-label">Run</span>
        {live === false ? (
          <p className="omp-hint">
            Run is quiescent (no live loop) — pause/resume/jobs need a live loop. Restart it with{" "}
            <code>ompo resume --run {runId}</code>
          </p>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              title="pause claiming — in-flight slices finish, nothing new claims"
              onClick={() => sendRun("pause")}
            >
              <Pause aria-hidden="true" />
              Pause
            </Button>
            <Button size="sm" variant="outline" disabled={busy} title="resume claiming" onClick={() => sendRun("resume")}>
              <Play aria-hidden="true" />
              Resume
            </Button>
            <span className="omp-control-label">Jobs</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label="Decrease jobs by one"
              title="set-jobs −1 (1..32)"
              onClick={() => stepJobs(-1)}
            >
              <Minus aria-hidden="true" />
            </Button>
            <Input
              value={jobs}
              onChange={(e) => setJobs(e.target.value)}
              size={3}
              aria-label="jobs"
              className="w-14 text-center font-mono"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label="Increase jobs by one"
              title="set-jobs +1 (1..32)"
              onClick={() => sendJobs(Number(jobs))}
            >
              <Plus aria-hidden="true" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title="apply the typed jobs value (1..32)"
              onClick={() => sendJobs(Number(jobs))}
            >
              <Check aria-hidden="true" />
              Set
            </Button>
          </>
        )}
      </div>

      <div className="omp-control-status" aria-live="polite">
        {requestError && (
          <p className="omp-error" role="alert">
            {requestError}
          </p>
        )}
        {pending && !outcome && (
          <p>
            <Badge variant="warning" data-tone="amber">
              pending
            </Badge>{" "}
            <code>
              #{pending.seq} {pending.kind}
              {pending.sliceId ? ` ${pending.sliceId}` : ""}
              {pending.jobs !== undefined ? ` jobs=${pending.jobs}` : ""}
            </code>{" "}
            — queued, waiting for the loop to confirm (watch Activity).
          </p>
        )}
        {pending && outcome && (
          <p>
            <Badge
              variant={outcome.type === "control_applied" ? "success" : "warning"}
              data-tone={outcome.type === "control_applied" ? "green" : "amber"}
            >
              {outcome.type === "control_applied" ? "applied" : "rejected"}
            </Badge>{" "}
            <span title={`#${outcome.seq} ${outcome.type} ${outcome.sliceId ?? "run"}${outcome.detail ? ` — ${outcome.detail}` : ""}`}>
              <code>
                #{pending.seq} {pending.kind}
                {pending.sliceId ? ` ${pending.sliceId}` : ""}
              </code>{" "}
              → {outcome.detail ?? outcome.type} (#{outcome.seq})
            </span>
          </p>
        )}
        {!pending && direct && (
          <p>
            <Badge variant={direct.ok ? "success" : "warning"} data-tone={direct.ok ? "green" : "amber"}>
              {direct.ok ? "applied" : "rejected"}
            </Badge>{" "}
            {direct.message} <span className="omp-hint">(direct — quiescent run)</span>
          </p>
        )}
        {!pending && !direct && !requestError && recentControl.length > 0 && (
          <ul className="omp-list" aria-label="Recent control events">
            {recentControl.map((e) => (
              <li key={e.seq} className="omp-list-item" title={`#${e.seq} ${e.type} ${e.sliceId ?? "run"}${e.detail ? ` — ${e.detail}` : ""}`}>
                <Badge
                  variant={
                    e.type === "control_applied"
                      ? "success"
                      : e.type === "control_rejected"
                        ? "warning"
                        : "secondary"
                  }
                  data-tone={
                    e.type === "control_applied"
                      ? "green"
                      : e.type === "control_rejected"
                        ? "amber"
                        : "muted"
                  }
                >
                  {e.type === "control_requested"
                    ? "pending"
                    : e.type === "control_applied"
                      ? "applied"
                      : "rejected"}
                </Badge>
                <code>#{e.seq}</code>
                <span className="omp-ellipsis">{e.detail ?? e.type}</span>
              </li>
            ))}
          </ul>
        )}
        {!pending && !direct && !requestError && recentControl.length === 0 && (
          <p className="omp-hint">
            {live === undefined
              ? "No control intents observed in the loaded events yet."
              : live
                ? "No control intents observed yet — queued intents apply when the loop drains (~2s)."
                : "Run is quiescent — intents apply directly."}
          </p>
        )}
      </div>
    </section>
  );
}
