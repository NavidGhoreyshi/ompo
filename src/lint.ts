/**
 * Roadmap lint (`ompo lint`, plus `run --dry-run` warnings): static checks
 * the parser can't reject but operators get wrong — vacuous gates, timeouts
 * past the split horizon, retry budgets that burn, `&&`-splits that changed
 * shell meaning, always-pass `|| true` gates, unknown agents, skips that
 * strand or silently pass dependents.
 *
 * Two levels: errors fail the command (exit 1) — the roadmap means something
 * the runner won't do. Warnings print and pass — judgment calls. Pure over
 * the markdown (+ optional project config); never touches the store.
 */

import { parseRoadmap, RoadmapParseError } from "./parse.ts";

export interface LintFinding {
  level: "error" | "warn";
  slice?: string;
  code: string;
  message: string;
}

export interface LintResult {
  errors: LintFinding[];
  warnings: LintFinding[];
}

export interface LintOptions {
  verifyDefaults?: string[];
  agentModels?: Record<string, string>;
}

/** Built-in omp agent names (per the orchestrator plan §1.3) — not config. */
const KNOWN_AGENTS = new Set(["task", "sonic"]);

/** A gate that only mutates shell state: proof its `&&` chain was split. */
const STATE_PREFIX = /^(cd|pushd|popd|export|readonly|local|declare|set|unset|alias|unalias|source|\.)(\s|$)/;

/** Format one finding for humans (`ompo lint`, dry-run). Pure. */
export function formatFinding(f: LintFinding): string {
  const where = f.slice ? `${f.slice}: ` : "";
  return `${f.level === "error" ? "error" : "warn"} [${f.code}] ${where}${f.message}`;
}

/** True when the roadmap fails lint (exit 1). Pure. */
export function lintFailed(r: LintResult): boolean {
  return r.errors.length > 0;
}

export function lintRoadmap(markdown: string, opts: LintOptions = {}): LintResult {
  const errors: LintFinding[] = [];
  const warnings: LintFinding[] = [];
  let doc;
  try {
    doc = parseRoadmap(markdown);
  } catch (err) {
    const msg = err instanceof RoadmapParseError ? err.message : String(err);
    errors.push({ level: "error", code: "parse", message: msg });
    return { errors, warnings };
  }

  const byId = new Map(doc.slices.map((s) => [s.id, s]));
  const dependents = new Map<string, string[]>();
  for (const s of doc.slices) {
    for (const d of s.deps) {
      const list = dependents.get(d) ?? [];
      list.push(s.id);
      dependents.set(d, list);
    }
  }

  for (const s of doc.slices) {
    const err = (code: string, message: string): void => {
      errors.push({ level: "error", slice: s.id, code, message });
    };
    const warn = (code: string, message: string): void => {
      warnings.push({ level: "warn", slice: s.id, code, message });
    };

    if (!s.skip && s.verify.length === 0 && (opts.verifyDefaults ?? []).length === 0) {
      err("no-verify", "no Verify: and no verifyDefaults — gates pass vacuously and broken code lands silent; add a repeatable gate");
    }
    for (const gate of s.verify) {
      if (STATE_PREFIX.test(gate.trim())) {
        err(
          "state-split",
          `gate ${JSON.stringify(gate.slice(0, 60))} only mutates shell state — its && chain was split into separate shells, so this does nothing for the next gate; wrap state-sharing chains as sh -c '...' (quoted && never splits)`,
        );
      }
      if (/\|\|/.test(gate)) {
        warn("or-gate", `gate ${JSON.stringify(gate.slice(0, 60))} uses || — fallbacks can mask real failures; fail closed instead`);
      }
    }
    if (new Set(s.verify).size !== s.verify.length) {
      warn("dup-gate", "duplicate gate commands — dedupe or split the slice");
    }
    if (s.timeoutMs !== undefined && s.timeoutMs > 60 * 60 * 1000) {
      warn("big-timeout", "Timeout past 60m — split the slice instead; long workers compound on retry");
    }
    if (s.maxRetries > 3) {
      warn("big-retries", `Retries ${s.maxRetries} burns budget fast — prefer smaller slices over more attempts`);
    }
    if (!s.effort) {
      warn("no-effort", "no Effort: (lo|med|hi) — schedulers and estimates fly blind; one word");
    }
    if (s.body.replace(/\s+/g, " ").trim().length < 20) {
      warn("thin-body", "body under 20 chars — the worker spec will be mostly scaffolding; say what done looks like");
    }
    for (const f of s.files) {
      if (f.startsWith("/") || f.startsWith("..")) {
        warn("files-escape", `Files entry ${JSON.stringify(f)} escapes the tree — gates run with cwd=worktree, keep entries repo-relative`);
      }
    }
    if (s.workerAgent && !/[/:._-]/.test(s.workerAgent) && !KNOWN_AGENTS.has(s.workerAgent) && !(opts.agentModels && opts.agentModels[s.workerAgent])) {
      warn("unknown-agent", `Agent: ${JSON.stringify(s.workerAgent)} is not a model pattern, a built-in (task|sonic), or an agentModels: key — the slice falls back to workerModel, maybe not what you meant`);
    }
    if (s.skip && (dependents.get(s.id) ?? []).length > 0) {
      warn("skip-with-dependents", `skipped but required by ${(dependents.get(s.id) ?? []).join(", ")} — downstream proceeds past skips, confirm that's intended`);
    }
    for (const d of s.deps) {
      if (byId.get(d)?.skip) {
        warn("dep-on-skipped", `depends on skipped slice ${d} — treated as satisfied, confirm that's intended`);
      }
    }
  }

  return { errors, warnings };
}
