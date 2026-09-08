/**
 * Chaos faults + determinism (`--fault-inject`, `--seed`).
 *
 * Deliberately explicit: faults ride only on CLI flags, never on config, so
 * a roadmap file can never smuggle `crash-after` into a real run. All
 * decisions are pure over this spec — the loop owns the side effects
 * (synthetic verdicts, aborts, process exit), which keeps every predicate
 * unit-testable without forking processes.
 *
 * Spec grammar (comma-separated `k=v`, `+` separates slice lists):
 *   fail-verify=s2+s3   — those slices' gates always fail (no command runs)
 *   abort-attempt=0.25  — per-attempt pre-verify abort draw, 0..1
 *   crash-after=5       — exit(137) once N slice pipelines have settled
 */

export interface FaultSpec {
  /** Slice ids whose gates fail synthetically. */
  failVerify: string[];
  /** Per-attempt abort probability (0 = off). */
  abortAttempt: number;
  /** Settle-count tripwire for a real crash (resume recovers). Absent = off. */
  crashAfter?: number;
}

export const EMPTY_FAULTS: FaultSpec = { failVerify: [], abortAttempt: 0 };

/** Parse `--fault-inject`. Throws on malformed input (CLI surfaces it). Pure. */
export function parseFaultSpec(raw: string): FaultSpec {
  const spec: FaultSpec = { failVerify: [], abortAttempt: 0 };
  const text = raw.trim();
  if (!text) throw new Error("--fault-inject needs a spec like fail-verify=s2,abort-attempt=0.25,crash-after=5");
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq === -1) throw new Error(`bad fault clause ${JSON.stringify(part)} (want k=v)`);
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "fail-verify") {
      const ids = value.split("+").map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) throw new Error("fail-verify needs at least one slice id");
      spec.failVerify.push(...ids);
    } else if (key === "abort-attempt") {
      const p = Number(value);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`abort-attempt needs a probability 0..1 (got ${JSON.stringify(value)})`);
      spec.abortAttempt = p;
    } else if (key === "crash-after") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`crash-after needs a positive integer (got ${JSON.stringify(value)})`);
      spec.crashAfter = n;
    } else {
      throw new Error(`unknown fault key ${JSON.stringify(key)} (want fail-verify|abort-attempt|crash-after)`);
    }
  }
  return spec;
}

/** True when any fault is armed. Pure. */
export function faultsArmed(spec: FaultSpec): boolean {
  return spec.failVerify.length > 0 || spec.abortAttempt > 0 || spec.crashAfter !== undefined;
}

/**
 * Deterministic RNG (mulberry32). Same seed → same abort draws, so a chaos
 * run replays. Non-crypto, never near secrets — scheduling draws only.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gate short-circuit: this slice's verdict is injected, no command runs. Pure. */
export function shouldFailVerify(spec: FaultSpec, sliceId: string): boolean {
  return spec.failVerify.includes(sliceId);
}

/** Pre-verify abort draw. Pure over the caller's rng (one draw per attempt). */
export function shouldAbortAttempt(spec: FaultSpec, rng: () => number): boolean {
  return spec.abortAttempt > 0 && rng() < spec.abortAttempt;
}

/** Crash tripwire: settled pipelines reached the injected count. Pure. */
export function shouldCrashAfter(spec: FaultSpec, settled: number): boolean {
  return spec.crashAfter !== undefined && settled >= spec.crashAfter;
}

/** Run-id suffix correlating chaos runs without breaking uniqueness. Pure. */
export function seedSuffix(seed: number | undefined): string {
  return seed === undefined ? "" : `-s${seed >>> 0}`;
}
