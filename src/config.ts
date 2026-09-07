/**
 * `.omp/roadmap.yml` — project-local overrides (plan §9, §11).
 * Minimal subset parser (no YAML dep): top-level `key: value` pairs,
 * `agentModels:` nested map, and `verifyDefaults:` / list keys.
 *
 * Supported keys:
 *   workerModel: <model pattern for omp --model>
 *   reviewModel: <independent reviewer model (defaults to workerModel)>
 *   maxRetries: <int default override>
 *   specBudget: <int chars>
 *   workerTimeoutSec: <int>
 *   debugTimeoutSec: <int worker-debug session budget, default 600>
 *   agentModels:
 *     <agent-name>: <model pattern>
 *   verifyDefaults:
 *     - <command>
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RoadmapConfig {
  workerModel?: string;
  /** Independent reviewer model (defaults to workerModel). */
  reviewModel?: string;
  maxRetries?: number;
  specBudget?: number;
  workerTimeoutSec?: number;
  /** Debugger session budget in seconds (default 600). */
  debugTimeoutSec?: number;
  /** Auto-inject dev-only placeholders for missing env creds (default true). */
  placeholders?: boolean;
  agentModels?: Record<string, string>;
  verifyDefaults?: string[];
}

export function configPath(projectDir: string): string {
  return join(projectDir, ".omp", "roadmap.yml");
}

function stripComment(line: string): string {
  // Cut unquoted trailing comments.
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}
function parseConfigInt(raw: string, key: string, min: number, max: number): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`.omp/roadmap.yml: ${key} must be an integer ${min}..${max} (got "${raw.trim()}")`);
  }
  return n;
}

function parseConfigBool(raw: string, key: string): boolean {
  const t = raw.trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(t)) return true;
  if (["false", "no", "0", "off"].includes(t)) return false;
  throw new Error(`.omp/roadmap.yml: ${key} must be true/false (got "${raw.trim()}")`);
}

 export function parseRoadmapYml(text: string): RoadmapConfig {
  const cfg: RoadmapConfig = {};
  let section: "root" | "agentModels" | "verifyDefaults" = "root";
  for (const raw of text.split("\n")) {
    const line = stripComment(raw).replace(/\r$/, "");
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (indent === 0) {
      if (trimmed.startsWith("- ")) {
        continue; // stray list item at root: ignore
      }
      const m = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1]!;
      const val = unquote(m[2] ?? "");
      if (key === "agentModels") section = "agentModels";
      else if (key === "verifyDefaults") {
        section = "verifyDefaults";
        cfg.verifyDefaults = [];
        if (val.startsWith("[")) {
          cfg.verifyDefaults = val
            .slice(1, val.endsWith("]") ? -1 : undefined)
            .split(",")
            .map((s) => unquote(s))
            .filter(Boolean);
          section = "root";
        }
      } else {
        section = "root";
        if (key === "workerModel" && val) cfg.workerModel = val;
        else if (key === "reviewModel" && val) cfg.reviewModel = val;
        else if (key === "maxRetries" && val) cfg.maxRetries = parseConfigInt(val, "maxRetries", 0, 10);
        else if (key === "specBudget" && val) cfg.specBudget = parseConfigInt(val, "specBudget", 1000, 1_000_000);
        else if (key === "workerTimeoutSec" && val) cfg.workerTimeoutSec = parseConfigInt(val, "workerTimeoutSec", 60, 8 * 3600);
        else if (key === "debugTimeoutSec" && val) cfg.debugTimeoutSec = parseConfigInt(val, "debugTimeoutSec", 60, 8 * 3600);
        else if (key === "placeholders" && val) cfg.placeholders = parseConfigBool(val, "placeholders");
      }
    } else if (section === "agentModels") {
      const m = trimmed.match(/^([^:]+?)\s*:\s*(.+)$/);
      if (m) {
        cfg.agentModels ??= {};
        cfg.agentModels[m[1]!.trim()] = unquote(m[2]!);
      }
    } else if (section === "verifyDefaults") {
      const m = trimmed.match(/^-\s+(.+)$/);
      if (m) cfg.verifyDefaults!.push(unquote(m[1]!));
    }
  }
  return cfg;
}

export function loadRoadmapConfig(projectDir: string): RoadmapConfig {
  const path = configPath(projectDir);
  if (!existsSync(path)) return {};
  return parseRoadmapYml(readFileSync(path, "utf8"));
}
