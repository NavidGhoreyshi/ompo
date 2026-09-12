/**
 * User-level ompo config — two model slots, project-overridable.
 *
 * Path: `${OMPO_CONFIG_HOME:-${XDG_CONFIG_HOME:-~/.config}/ompo}/config.yml`.
 * `OMPO_CONFIG_HOME` names the ompo config directory itself (tests + CI point
 * it at a temp dir); XDG_CONFIG_HOME appends the usual `ompo/` subdir.
 *
 * The file uses the same subset parser as `.omp/roadmap.yml` (no YAML dep).
 * Two slots are the setup surface — `deepModel` (strong: orchestrator,
 * reviewer, debugger, escalated workers) and `fastModel` (default worker,
 * review minor-fix lane). Per-role keys stay available as explicit overrides.
 *
 * Precedence per role: project explicit role > global explicit role >
 * slot-derived > built-in default. `resolveRoles` folds the workerModel pin
 * into the deep slot as well, so projects that pinned only `workerModel`
 * (every project created before the slots existed) keep their old behavior.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRoadmapConfig, parseConfigYml, type RoadmapConfig } from "./config.ts";
import type { Effort } from "./types.ts";

/**
 * Last-resort model when nothing is configured anywhere: the paid pool model
 * every ompo-generated project already pins, so config-less projects and CI
 * keep behaving exactly as before the slots existed.
 */
export const BUILTIN_DEFAULT_MODEL = "opencode-go/muse-spark-1.3-contributor";

/** Ordered chain stamped into new projects and offered by `ompo setup`. */
export const DEFAULT_MODEL_FALLBACKS: readonly string[] = [
  "opencode-go/mimo-v2.5",
  "muse-spark-1.3-contributor-free",
  "deepseek-v4-flash-free",
];

export interface ConfigLocation {
  env?: Record<string, string | undefined>;
  /** Home directory override (tests); default the real home. */
  home?: string;
}

/** Directory holding the global config (`OMPO_CONFIG_HOME` wins verbatim). */
export function globalConfigDir(loc: ConfigLocation = {}): string {
  const env = loc.env ?? process.env;
  const override = env["OMPO_CONFIG_HOME"];
  if (override && override.trim()) return override.trim();
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.trim() ? xdg.trim() : join(loc.home ?? homedir(), ".config");
  return join(base, "ompo");
}

export function globalConfigPath(loc: ConfigLocation = {}): string {
  return join(globalConfigDir(loc), "config.yml");
}

/** Load the global config; absent file = all defaults. Parse errors throw. */
export function loadGlobalConfig(loc: ConfigLocation = {}): RoadmapConfig {
  const path = globalConfigPath(loc);
  if (!existsSync(path)) return {};
  return parseConfigYml(readFileSync(path, "utf8"), path);
}

/**
 * Shallow merge: project keys win, global keys fill the gap. Parsed configs
 * only carry keys the file actually set, so an absent project key never
 * clobbers the global value.
 */
export function mergeConfigs(project: RoadmapConfig, global: RoadmapConfig): RoadmapConfig {
  return { ...global, ...project };
}

/** The effective config a run/plan uses: project merged over global. */
export function loadEffectiveConfig(projectDir: string, loc: ConfigLocation = {}): RoadmapConfig {
  return mergeConfigs(loadRoadmapConfig(projectDir), loadGlobalConfig(loc));
}

/** Where a resolved role model came from (shown by `ompo config --explain`). */
export type ModelSource = "project" | "global" | "slot" | "default";

export interface ResolvedRole {
  model: string;
  source: ModelSource;
}

export interface ResolvedRoles {
  orchestrator: ResolvedRole;
  worker: ResolvedRole;
  reviewer: ResolvedRole;
  debugger: ResolvedRole;
  /** The two setup slots themselves (escalation reads `deep`). */
  deep: ResolvedRole;
  fast: ResolvedRole;
}

interface Candidate {
  model?: string;
  source: ModelSource;
}

function pickRole(candidates: Candidate[]): ResolvedRole {
  for (const c of candidates) {
    if (typeof c.model === "string" && c.model.trim()) {
      return { model: c.model.trim(), source: c.source };
    }
  }
  return { model: BUILTIN_DEFAULT_MODEL, source: "default" };
}

/**
 * Resolve the four spawn roles + the two slots. Pure — unit-tested.
 *
 * Slot derivation: an explicit slot key (project then global) wins; otherwise
 * the project/global `workerModel` pin seeds both slots, which is what keeps
 * pre-slot projects byte-identical (reviewer used to default to workerModel).
 */
export function resolveRoles(project: RoadmapConfig, global: RoadmapConfig): ResolvedRoles {
  const deepCandidates: Candidate[] = [
    { model: project.deepModel, source: "project" },
    { model: global.deepModel, source: "slot" },
    { model: project.workerModel, source: "project" },
    { model: global.workerModel, source: "global" },
  ];
  const fastCandidates: Candidate[] = [
    { model: project.fastModel, source: "project" },
    { model: global.fastModel, source: "slot" },
    { model: project.workerModel, source: "project" },
    { model: global.workerModel, source: "global" },
  ];
  const deep = pickRole(deepCandidates);
  const fast = pickRole(fastCandidates);
  return {
    deep,
    fast,
    orchestrator: pickRole([
      { model: project.orchestratorModel, source: "project" },
      { model: global.orchestratorModel, source: "global" },
      ...deepCandidates,
    ]),
    reviewer: pickRole([
      { model: project.reviewModel, source: "project" },
      { model: global.reviewModel, source: "global" },
      ...deepCandidates,
    ]),
    debugger: pickRole([
      { model: project.debugModel, source: "project" },
      { model: global.debugModel, source: "global" },
      ...deepCandidates,
    ]),
    worker: pickRole([
      { model: project.workerModel, source: "project" },
      { model: global.workerModel, source: "global" },
      ...fastCandidates,
    ]),
  };
}

/** Why a worker was escalated to the deep slot. */
export type EscalationCause = "attempt" | "effort";

/**
 * Model escalation rule (model only — thinking stays max): retries (attempt
 * ≥ 2) and `Effort: hi` slices run on the deep model. Pure — unit-tested.
 */
export function escalationReason(attempt: number, effort: Effort | undefined): EscalationCause | null {
  if (Number.isFinite(attempt) && attempt >= 2) return "attempt";
  if (effort === "hi") return "effort";
  return null;
}
