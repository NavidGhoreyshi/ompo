import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigYml } from "../src/config.ts";
import {
  buildGlobalConfigText,
  groupByProvider,
  needsSetup,
  parseModelsJson,
  runSetup,
  writeConfigAtomic,
} from "../src/setup.ts";

const MODELS_JSON = JSON.stringify({
  models: [
    { provider: "opencode-go", id: "muse", selector: "opencode-go/muse-spark-1.3-contributor", name: "Muse Spark Contributor" },
    { provider: "opencode-go", id: "muse-free", selector: "muse-spark-1.3-contributor-free", name: "Muse Spark Free" },
    { provider: "opencode-go", id: "mimo", selector: "opencode-go/mimo-v2.5", name: "MiMo V2.5" },
    { provider: "zen", id: "flash-free", selector: "deepseek-v4-flash-free", name: "DeepSeek Flash Free" },
  ],
});

describe("parseModelsJson", () => {
  test("reads selector/name/provider from the catalog", () => {
    const models = parseModelsJson(MODELS_JSON);
    expect(models).toHaveLength(4);
    expect(models[0]).toEqual({
      selector: "opencode-go/muse-spark-1.3-contributor",
      name: "Muse Spark Contributor",
      provider: "opencode-go",
    });
  });
  test("malformed input yields an empty catalog", () => {
    expect(parseModelsJson("not json")).toEqual([]);
    expect(parseModelsJson("{}")).toEqual([]);
    expect(parseModelsJson(JSON.stringify({ models: [null, { name: "no selector" }] }))).toEqual([]);
  });
});

describe("needsSetup", () => {
  test("offers the wizard only with no config anywhere on a TTY", () => {
    expect(needsSetup({ projectConfig: false, globalConfig: false, tty: true })).toBe(true);
  });
  test("skips when either config exists, when piped, or when disabled", () => {
    expect(needsSetup({ projectConfig: true, globalConfig: false, tty: true })).toBe(false);
    expect(needsSetup({ projectConfig: false, globalConfig: true, tty: true })).toBe(false);
    expect(needsSetup({ projectConfig: false, globalConfig: false, tty: false })).toBe(false);
    expect(needsSetup({ projectConfig: false, globalConfig: false, tty: true, noSetup: true })).toBe(false);
  });
});

describe("buildGlobalConfigText", () => {
  test("round-trips slots, fallbacks, maps and lists through the parser", () => {
    const text = buildGlobalConfigText({
      deepModel: "d",
      fastModel: "f",
      modelFallbacks: ["a", "b"],
      verifyDefaults: ["bun test"],
      serviceEnv: { URL: "postgres://x?y=1#frag" },
      maxRetries: 2,
    });
    const cfg = parseConfigYml(text);
    expect(cfg.deepModel).toBe("d");
    expect(cfg.fastModel).toBe("f");
    expect(cfg.modelFallbacks).toEqual(["a", "b"]);
    expect(cfg.verifyDefaults).toEqual(["bun test"]);
    expect(cfg.serviceEnv).toEqual({ URL: "postgres://x?y=1#frag" });
    expect(cfg.maxRetries).toBe(2);
  });
});

describe("writeConfigAtomic", () => {
  test("writes the file (temp + rename) and leaves no temp behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    const path = join(dir, "config.yml");
    writeConfigAtomic(path, "deepModel: d\n");
    expect(readFileSync(path, "utf8")).toBe("deepModel: d\n");
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });
});

describe("groupByProvider", () => {
  test("groups in catalog order and counts models", () => {
    const groups = groupByProvider(parseModelsJson(MODELS_JSON));
    expect(groups.map((g) => [g.name, g.models.length])).toEqual([
      ["opencode-go", 3],
      ["zen", 1],
    ]);
  });
});

describe("runSetup", () => {
  test("filters, picks, and writes slots + fallbacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    const answers = ["mimo", "flash", ""];
    const printed: string[] = [];
    const res = await runSetup({
      env: { OMPO_CONFIG_HOME: dir },
      ask: async () => answers.shift() ?? "",
      print: (m) => printed.push(m),
      listModels: () => parseModelsJson(MODELS_JSON),
      probeModel: () => true,
    });
    expect(res.path).toBe(join(dir, "config.yml"));
    expect(res.written).toBe(true);
    const cfg = parseConfigYml(readFileSync(res.path, "utf8"), res.path);
    expect(cfg.deepModel).toBe("opencode-go/mimo-v2.5");
    expect(cfg.fastModel).toBe("deepseek-v4-flash-free");
    expect(cfg.modelFallbacks && cfg.modelFallbacks.length).toBeGreaterThan(0);
    expect(printed.some((l) => l.includes("roles — orchestrator:"))).toBe(true);
    expect(printed.some((l) => l.includes("log in to each provider's"))).toBe(true);
    expect(printed.some((l) => l.includes("reachable"))).toBe(true);
  });

  test("ambiguous filter lists matches and picks by number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    const answers = ["muse", "2", "mimo", "n"];
    await runSetup({
      env: { OMPO_CONFIG_HOME: dir },
      ask: async () => answers.shift() ?? "",
      print: () => {},
      listModels: () => parseModelsJson(MODELS_JSON),
      probeModel: () => true,
    });
    const cfg = parseConfigYml(readFileSync(join(dir, "config.yml"), "utf8"));
    expect(cfg.deepModel).toBe("muse-spark-1.3-contributor-free");
    expect(cfg.fastModel).toBe("opencode-go/mimo-v2.5");
    expect(cfg.modelFallbacks).toBeUndefined();
  });

  test("unmatched input is accepted as a raw selector", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    const answers = ["private/house-model", "", ""];
    await runSetup({
      env: { OMPO_CONFIG_HOME: dir },
      ask: async () => answers.shift() ?? "",
      print: () => {},
      listModels: () => parseModelsJson(MODELS_JSON),
      probeModel: () => true,
    });
    const cfg = parseConfigYml(readFileSync(join(dir, "config.yml"), "utf8"));
    expect(cfg.deepModel).toBe("private/house-model");
    expect(cfg.fastModel).toBe("opencode-go/muse-spark-1.3-contributor");
  });

  test("provider-first: pick a provider, then a model from its list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    const answers = ["1", "1", "2", ""];
    const printed: string[] = [];
    await runSetup({
      env: { OMPO_CONFIG_HOME: dir },
      ask: async () => answers.shift() ?? "",
      print: (m) => printed.push(m),
      listModels: () => parseModelsJson(MODELS_JSON),
      probeModel: () => true,
    });
    const cfg = parseConfigYml(readFileSync(join(dir, "config.yml"), "utf8"));
    expect(cfg.deepModel).toBe("opencode-go/muse-spark-1.3-contributor");
    expect(cfg.fastModel).toBe("deepseek-v4-flash-free");
    expect(printed.some((l) => l.includes("1) opencode-go (3 models)"))).toBe(true);
    expect(printed.some((l) => l.includes("2) zen (1 models)"))).toBe(true);
  });

  test("provider-first: filter narrows within the chosen provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    const answers = ["1", "contributor-free", "", ""];
    await runSetup({
      env: { OMPO_CONFIG_HOME: dir },
      ask: async () => answers.shift() ?? "",
      print: () => {},
      listModels: () => parseModelsJson(MODELS_JSON),
      probeModel: () => true,
    });
    const cfg = parseConfigYml(readFileSync(join(dir, "config.yml"), "utf8"));
    expect(cfg.deepModel).toBe("muse-spark-1.3-contributor-free");
    expect(cfg.fastModel).toBe("opencode-go/muse-spark-1.3-contributor");
  });

  test("unreachable pick warns and can be kept with 'n'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    const answers = ["mimo", "n", "flash", ""];
    const printed: string[] = [];
    await runSetup({
      env: { OMPO_CONFIG_HOME: dir },
      ask: async () => answers.shift() ?? "",
      print: (m) => printed.push(m),
      listModels: () => parseModelsJson(MODELS_JSON),
      probeModel: (m) => m !== "opencode-go/mimo-v2.5",
    });
    const cfg = parseConfigYml(readFileSync(join(dir, "config.yml"), "utf8"));
    expect(cfg.deepModel).toBe("opencode-go/mimo-v2.5");
    expect(cfg.fastModel).toBe("deepseek-v4-flash-free");
    expect(printed.some((l) => l.includes("not reachable via omp"))).toBe(true);
  });

  test("unreachable pick can be replaced; the replacement is probed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    const answers = ["mimo", "", "1", "", ""];
    const probes: string[] = [];
    await runSetup({
      env: { OMPO_CONFIG_HOME: dir },
      ask: async () => answers.shift() ?? "",
      print: () => {},
      listModels: () => parseModelsJson(MODELS_JSON),
      probeModel: (m) => {
        probes.push(m);
        return m !== "opencode-go/mimo-v2.5";
      },
    });
    const cfg = parseConfigYml(readFileSync(join(dir, "config.yml"), "utf8"));
    expect(cfg.deepModel).toBe("opencode-go/muse-spark-1.3-contributor");
    expect(cfg.fastModel).toBe("opencode-go/muse-spark-1.3-contributor");
    expect(probes.filter((p) => p === "opencode-go/mimo-v2.5").length).toBe(1);
  });

  test("picking the same model for both slots probes it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    const answers = ["mimo", "mimo", ""];
    let calls = 0;
    await runSetup({
      env: { OMPO_CONFIG_HOME: dir },
      ask: async () => answers.shift() ?? "",
      print: () => {},
      listModels: () => parseModelsJson(MODELS_JSON),
      probeModel: () => {
        calls += 1;
        return true;
      },
    });
    const cfg = parseConfigYml(readFileSync(join(dir, "config.yml"), "utf8"));
    expect(cfg.deepModel).toBe("opencode-go/mimo-v2.5");
    expect(cfg.fastModel).toBe("opencode-go/mimo-v2.5");
    expect(calls).toBe(1);
  });

  test("re-run keeps existing overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-setup-"));
    writeConfigAtomic(join(dir, "config.yml"), "deepModel: old-deep\nreviewModel: keep-me\n");
    const answers = ["", "", ""];
    await runSetup({
      env: { OMPO_CONFIG_HOME: dir },
      ask: async () => answers.shift() ?? "",
      print: () => {},
      listModels: () => [],
      probeModel: () => true,
    });
    const cfg = parseConfigYml(readFileSync(join(dir, "config.yml"), "utf8"));
    expect(cfg.deepModel).toBe("old-deep");
    expect(cfg.reviewModel).toBe("keep-me");
  });
});
