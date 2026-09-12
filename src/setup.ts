/**
 * `ompo setup` — global model-role setup (first-run + re-runnable).
 *
 * Writes two slots into the user-level config (`deepModel`, `fastModel`):
 * every role resolves from them (see globalConfig.resolveRoles), so one
 * wizard configures all projects at once. Project files stay authoritative
 * when they set a role explicitly.
 *
 * The wizard reads omp's own catalog (`omp models ls --json`) and walks it
 * provider-first: pick a provider, then a model from its list (numbered when
 * ≤25, filtered when larger). Typing a filter or full selector at the
 * provider prompt searches the whole catalog instead. Never dumps all 600+
 * models; no prompt library — plain readline.
 *
 * The catalog is not auth-aware (omp must already be logged in to each
 * provider), so every pick is reachability-probed with a real minimal omp
 * call (`--thinking=off`, exit 0 = usable): an unreachable model warns and
 * can be kept or replaced. Tests inject
 * ask/print/listModels/probeModel/readFile/writeFile.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseConfigYml, type RoadmapConfig } from "./config.ts";
import { BUILTIN_DEFAULT_MODEL, DEFAULT_MODEL_FALLBACKS, globalConfigPath, resolveRoles, type ConfigLocation } from "./globalConfig.ts";
import { probeOmpModel } from "./worker.ts";

export interface ModelChoice {
  selector: string;
  name: string;
  provider: string;
}

/** Parse `omp models ls --json`; malformed input yields an empty catalog. */
export function parseModelsJson(raw: string): ModelChoice[] {
  try {
    const parsed = JSON.parse(raw) as { models?: unknown };
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.models)) return [];
    const out: ModelChoice[] = [];
    for (const m of parsed.models) {
      if (typeof m !== "object" || m === null) continue;
      const r = m as Record<string, unknown>;
      const selector = typeof r["selector"] === "string" ? r["selector"] : undefined;
      if (!selector) continue;
      out.push({
        selector,
        name: typeof r["name"] === "string" && r["name"].trim() ? r["name"] : selector,
        provider: typeof r["provider"] === "string" ? r["provider"] : "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Real model discovery (`omp models ls --json`), [] when omp is unavailable. */
export function listOmpModels(): ModelChoice[] {
  try {
    const r = spawnSync("omp", ["models", "ls", "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? parseModelsJson(r.stdout ?? "") : [];
  } catch {
    return [];
  }
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * First-run rule: offer the wizard only when neither config level exists and
 * the session is a TTY. CI/pipes silently keep the built-in default; explicit
 * `ompo setup` and `--no-setup` bypass this predicate entirely.
 */
export function needsSetup(o: {
  projectConfig: boolean;
  globalConfig: boolean;
  tty: boolean;
  noSetup?: boolean;
}): boolean {
  if (o.noSetup) return false;
  if (o.globalConfig || o.projectConfig) return false;
  return o.tty;
}

/** Write via temp + rename so a crash never leaves a torn config. */
export function writeConfigAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function yamlScalar(v: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(v) ? v : JSON.stringify(v);
}

/**
 * Serialize the model-domain config keys the wizard manages (plus anything
 * else the existing file carried). Hand-rolled to match the subset parser;
 * sprint 8's key-level writer replaces the rewrite eventually.
 */
export function buildGlobalConfigText(cfg: RoadmapConfig): string {
  const out: string[] = [
    "# ompo global config — user-level model roles + defaults.",
    "# Every key is optional; project .omp/roadmap.yml overrides any of them.",
    "# Edit by hand or re-run `ompo setup` (atomic rewrite).",
    "",
  ];
  const scalar = (key: string, v: string | undefined): void => {
    if (v !== undefined && v.trim() !== "") out.push(`${key}: ${yamlScalar(v)}`);
  };
  scalar("deepModel", cfg.deepModel);
  scalar("fastModel", cfg.fastModel);
  scalar("orchestratorModel", cfg.orchestratorModel);
  scalar("debugModel", cfg.debugModel);
  scalar("workerModel", cfg.workerModel);
  scalar("reviewModel", cfg.reviewModel);
  if (cfg.modelFallbacks && cfg.modelFallbacks.length > 0) {
    out.push("modelFallbacks:");
    for (const f of cfg.modelFallbacks) out.push(`  - ${yamlScalar(f)}`);
  }
  if (cfg.agentModels && Object.keys(cfg.agentModels).length > 0) {
    out.push("agentModels:");
    for (const [k, v] of Object.entries(cfg.agentModels)) out.push(`  ${yamlScalar(k)}: ${yamlScalar(v)}`);
  }
  const ints: Array<[string, number | undefined]> = [
    ["maxRetries", cfg.maxRetries],
    ["specBudget", cfg.specBudget],
    ["workerTimeoutSec", cfg.workerTimeoutSec],
    ["debugTimeoutSec", cfg.debugTimeoutSec],
    ["serviceTimeoutSec", cfg.serviceTimeoutSec],
    ["maxUnblocks", cfg.maxUnblocks],
    ["contextCapTokens", cfg.contextCapTokens],
  ];
  for (const [key, v] of ints) if (v !== undefined) out.push(`${key}: ${v}`);
  if (cfg.placeholders !== undefined) out.push(`placeholders: ${cfg.placeholders}`);
  const lists: Array<[string, string[] | undefined]> = [
    ["verifyDefaults", cfg.verifyDefaults],
    ["serviceUp", cfg.serviceUp],
    ["serviceReady", cfg.serviceReady],
  ];
  for (const [key, list] of lists) {
    if (!list || list.length === 0) continue;
    out.push(`${key}:`);
    for (const item of list) out.push(`  - ${yamlScalar(item)}`);
  }
  if (cfg.serviceEnv && Object.keys(cfg.serviceEnv).length > 0) {
    out.push("serviceEnv:");
    for (const [k, v] of Object.entries(cfg.serviceEnv)) out.push(`  ${yamlScalar(k)}: ${yamlScalar(v)}`);
  }
  return out.join("\n") + "\n";
}

export interface SetupIO extends ConfigLocation {
  /** Test seam: answer supplier (default readline on stdin/stdout). */
  ask?: (question: string) => Promise<string>;
  print?: (line: string) => void;
  /** Test seam: model catalog (default `omp models ls --json`). */
  listModels?: () => ModelChoice[];
  /** Test seam: reachability probe (default `omp --model M --help`). */
  probeModel?: (selector: string) => boolean;
  readFile?: (path: string) => string | null;
  /** Test seam: config writer (default atomic temp+rename). */
  writeFile?: (path: string, text: string) => void;
}

export interface SetupResult {
  path: string;
  config: RoadmapConfig;
  /** False when the serialized config matches what was already on disk. */
  written: boolean;
}

const MAX_MATCHES = 25;

export interface ProviderGroup {
  name: string;
  models: ModelChoice[];
}

/** Group the catalog by provider, preserving the catalog's provider order. */
export function groupByProvider(models: ModelChoice[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const byName = new Map<string, ProviderGroup>();
  for (const m of models) {
    const name = m.provider || "(unknown)";
    let g = byName.get(name);
    if (!g) {
      g = { name, models: [] };
      byName.set(name, g);
      groups.push(g);
    }
    g.models.push(m);
  }
  return groups;
}

function matchModels(models: ModelChoice[], needle: string): ModelChoice[] {
  const n = needle.toLowerCase();
  return models.filter((m) => m.selector.toLowerCase().includes(n) || m.name.toLowerCase().includes(n));
}

/**
 * Ask for one slot, provider-first: pick a provider, then a model from its
 * list (numbered when ≤25, filtered otherwise). Typing a filter or full
 * selector at the provider prompt searches the whole catalog instead, and an
 * unmatched selector is accepted raw so unlisted/remote ids stay typeable.
 */
async function pickModel(
  ask: (q: string) => Promise<string>,
  print: (m: string) => void,
  label: string,
  models: ModelChoice[],
  fallback: string,
): Promise<string> {
  print(label);
  if (models.length === 0) {
    const input = (await ask(`  model selector [default: ${fallback}]: `)).trim();
    if (input) return input;
    print(`  no model catalog available — using default ${fallback}`);
    return fallback;
  }

  const providers = groupByProvider(models);
  let pool = models;
  let input = "";
  if (providers.length > 1) {
    providers.forEach((g, i) => print(`  ${i + 1}) ${g.name} (${g.models.length} models)`));
    input = (await ask(`  pick provider [1-${providers.length}], or filter/paste a selector [default: ${fallback}]: `)).trim();
    if (!input) return fallback;
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= providers.length) {
      const chosen = providers[n - 1]!;
      print(`  → ${chosen.name}`);
      pool = chosen.models;
      input = "";
    }
  } else if (providers.length === 1) {
    pool = providers[0]!.models;
  }

  if (input === "" && pool !== models) {
    // Provider chosen: list small pools outright, otherwise filter.
    if (pool.length === 1) {
      print(`  → ${pool[0]!.selector}`);
      return pool[0]!.selector;
    }
    if (pool.length <= MAX_MATCHES) {
      pool.forEach((m, i) => print(`  ${i + 1}) ${m.selector}${m.name !== m.selector ? ` — ${m.name}` : ""}`));
      input = (await ask(`  pick [1-${pool.length}], filter, or Enter for default [${fallback}]: `)).trim();
      if (!input) return fallback;
      const k = Number(input);
      if (Number.isInteger(k) && k >= 1 && k <= pool.length) return pool[k - 1]!.selector;
    } else {
      print(`  ${pool.length} models — narrow with a filter`);
      input = (await ask(`  filter or full selector [default: ${fallback}]: `)).trim();
      if (!input) return fallback;
    }
  }

  for (;;) {
    if (!input) return fallback;
    const matches = matchModels(pool, input);
    if (matches.length === 1) {
      print(`  → ${matches[0]!.selector}`);
      return matches[0]!.selector;
    }
    if (matches.length > 1 && matches.length <= MAX_MATCHES) {
      matches.forEach((m, i) => print(`  ${i + 1}) ${m.selector}${m.name !== m.selector ? ` — ${m.name}` : ""}`));
      const pick = (await ask(`  pick [1-${matches.length}, Enter to search again]: `)).trim();
      if (!pick) {
        input = (await ask(`  filter or full selector [default: ${fallback}]: `)).trim();
        continue;
      }
      const n = Number(pick);
      if (Number.isInteger(n) && n >= 1 && n <= matches.length) return matches[n - 1]!.selector;
      return pick; // raw selector typed at the pick prompt
    }
    if (matches.length > MAX_MATCHES) {
      print(`  ${matches.length} matches — narrow the filter`);
      input = (await ask(`  filter or full selector [default: ${fallback}]: `)).trim();
      continue;
    }
    print(`  no catalog match — using "${input}" as a raw selector`);
    return input;
  }
}

/**
 * Pick a model and probe it: an unreachable selector (unknown id, or the
 * provider is not logged in on this omp install) warns and offers a re-pick.
 * The user can keep it (`n`), replace it, or re-pick the same model (the
 * second time it is accepted with a note — no infinite loop on piped input).
 */
async function pickReachable(
  ask: (q: string) => Promise<string>,
  print: (m: string) => void,
  label: string,
  models: ModelChoice[],
  fallback: string,
  probe: ((selector: string) => boolean) | null,
): Promise<string> {
  const failed = new Set<string>();
  for (;;) {
    const model = await pickModel(ask, print, label, models, fallback);
    if (!probe) return model;
    print(`  probing ${model} with a minimal omp call…`);
    if (probe(model)) {
      print(`  ✓ ${model} reachable`);
      return model;
    }
    if (failed.has(model)) {
      print(`  keeping ${model} (still unreachable — spawns will fall back)`);
      return model;
    }
    failed.add(model);
    print(`  ✗ ${model} not reachable via omp — log in to its provider in omp, or pick another model.`);
    const answer = (await ask(`  choose another model? [Y/n] `)).trim().toLowerCase();
    if (answer === "n" || answer === "no") return model;
  }
}

/**
 * Run the wizard. Interactive by default; pass `ask` to script it. Returns
 * the written config. Parse errors in an existing file throw (fail closed
 * rather than silently overwrite a hand-edited config).
 */
export async function runSetup(io: SetupIO = {}): Promise<SetupResult> {
  const print = io.print ?? ((m: string) => console.log(m));
  const path = globalConfigPath(io);
  const readFile = io.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null));
  const writeFile = io.writeFile ?? writeConfigAtomic;
  const rawExisting = readFile(path);
  const existing: RoadmapConfig = rawExisting ? parseConfigYml(rawExisting, path) : {};
  const models = (io.listModels ?? listOmpModels)();
  const probeFn = io.probeModel ?? probeOmpModel;
  const probeCache = new Map<string, boolean>();
  // Probing spawns a real omp call; skip it when discovery already failed
  // (no omp), and never probe the same selector twice.
  const canProbe = models.length > 0;
  const probe = (selector: string): boolean => {
    let hit = probeCache.get(selector);
    if (hit === undefined) {
      hit = probeFn(selector);
      probeCache.set(selector, hit);
    }
    return hit;
  };

  let rl: ReturnType<typeof createInterface> | undefined;
  const queuedLines: string[] = [];
  let pendingLine: ((line: string) => void) | null = null;
  let closed = false;
  const fromStdin = (q: string): Promise<string> => {
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      // Queue every line: piped stdin arrives in one chunk, and question()
      // would silently drop the lines that land while no question is pending.
      rl.on("line", (line) => {
        if (pendingLine) {
          const resolve = pendingLine;
          pendingLine = null;
          resolve(line);
        } else {
          queuedLines.push(line);
        }
      });
      rl.on("close", () => {
        closed = true;
        if (pendingLine) {
          const resolve = pendingLine;
          pendingLine = null;
          resolve("");
        }
      });
    }
    process.stdout.write(q);
    const next = queuedLines.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (closed) return Promise.resolve("");
    return new Promise<string>((resolve) => {
      pendingLine = resolve;
    });
  };
  const ask = io.ask ?? fromStdin;
  try {
    print("ompo setup — model roles for every project");
    print(`global config: ${path}`);
    print("note: model choices come from your omp install — log in to each provider's");
    print("account in omp first. Unauthenticated models are listed but fail at spawn;");
    print("the models you pick here are probed for reachability.");
    print(models.length > 0
      ? `found ${models.length} model(s) via \`omp models ls --json\``
      : "could not list models — type model selectors by hand");

    const deep = await pickReachable(
      ask,
      print,
      "Deep model — orchestrator, reviewer, debugger, escalated workers",
      models,
      existing.deepModel ?? BUILTIN_DEFAULT_MODEL,
      canProbe ? probe : null,
    );
    const fast = await pickReachable(
      ask,
      print,
      "Fast model — default worker, review minor-fix lane",
      models,
      existing.fastModel ?? BUILTIN_DEFAULT_MODEL,
      canProbe ? probe : null,
    );

    const proposed = existing.modelFallbacks && existing.modelFallbacks.length > 0
      ? existing.modelFallbacks
      : [...DEFAULT_MODEL_FALLBACKS];
    const answer = (await ask(`Fallbacks when a model is unavailable: ${proposed.join(", ")} — keep? [Y/n] `))
      .trim()
      .toLowerCase();
    const fallbacks = answer === "n" || answer === "no" ? [] : proposed;

    const next: RoadmapConfig = { ...existing, deepModel: deep, fastModel: fast };
    if (fallbacks.length > 0) next.modelFallbacks = [...fallbacks];
    else delete next.modelFallbacks;

    const text = buildGlobalConfigText(next);
    const written = text !== (rawExisting ?? "");
    if (written) writeFile(path, text);

    const roles = resolveRoles({}, next);
    print(written ? `wrote ${path}` : `kept ${path} (unchanged)`);
    print(`roles — orchestrator: ${roles.orchestrator.model} · worker: ${roles.worker.model} · reviewer: ${roles.reviewer.model} · debugger: ${roles.debugger.model}`);
    print("project overrides still win: review `ompo config --explain`");
    return { path, config: next, written };
  } finally {
    rl?.close();
  }
}
