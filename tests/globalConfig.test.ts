import { describe, expect, test } from "bun:test";
import { parseConfigYml, parseRoadmapYml } from "../src/config.ts";
import {
  BUILTIN_DEFAULT_MODEL,
  escalationReason,
  globalConfigDir,
  globalConfigPath,
  mergeConfigs,
  resolveRoles,
} from "../src/globalConfig.ts";

describe("global config path", () => {
  test("OMPO_CONFIG_HOME names the ompo config dir verbatim", () => {
    expect(globalConfigDir({ env: { OMPO_CONFIG_HOME: "/tmp/ompo-cfg" } })).toBe("/tmp/ompo-cfg");
    expect(globalConfigPath({ env: { OMPO_CONFIG_HOME: "/tmp/ompo-cfg" } })).toBe("/tmp/ompo-cfg/config.yml");
  });
  test("XDG_CONFIG_HOME appends the ompo/ subdir", () => {
    expect(globalConfigPath({ env: { XDG_CONFIG_HOME: "/xdg" } })).toBe("/xdg/ompo/config.yml");
  });
  test("falls back to ~/.config/ompo", () => {
    expect(globalConfigPath({ env: {}, home: "/home/u" })).toBe("/home/u/.config/ompo/config.yml");
  });
});

describe("config parser slot keys", () => {
  test("parses deep/fast/orchestrator/debug keys", () => {
    const cfg = parseRoadmapYml(
      "deepModel: deep-1\nfastModel: fast-1\norchestratorModel: orch-1\ndebugModel: dbg-1\n",
    );
    expect(cfg.deepModel).toBe("deep-1");
    expect(cfg.fastModel).toBe("fast-1");
    expect(cfg.orchestratorModel).toBe("orch-1");
    expect(cfg.debugModel).toBe("dbg-1");
  });
  test("global parse errors name the global file, not roadmap.yml", () => {
    expect(() => parseConfigYml("maxRetries: nope\n", "/x/config.yml")).toThrow("/x/config.yml");
    expect(() => parseConfigYml("maxRetries: nope\n")).toThrow(".omp/roadmap.yml");
  });
});

describe("resolveRoles precedence", () => {
  test("nothing configured → built-in default everywhere", () => {
    const roles = resolveRoles({}, {});
    for (const name of ["orchestrator", "worker", "reviewer", "debugger", "deep", "fast"] as const) {
      expect(roles[name]).toEqual({ model: BUILTIN_DEFAULT_MODEL, source: "default" });
    }
  });

  test("global slots derive every role (deep roles ≠ worker by default)", () => {
    const roles = resolveRoles({}, { deepModel: "d", fastModel: "f" });
    expect(roles.deep).toEqual({ model: "d", source: "slot" });
    expect(roles.fast).toEqual({ model: "f", source: "slot" });
    expect(roles.orchestrator).toEqual({ model: "d", source: "slot" });
    expect(roles.reviewer).toEqual({ model: "d", source: "slot" });
    expect(roles.debugger).toEqual({ model: "d", source: "slot" });
    expect(roles.worker).toEqual({ model: "f", source: "slot" });
    expect(roles.reviewer.model).not.toBe(roles.worker.model);
  });

  test("project explicit role > global explicit role > slot", () => {
    const roles = resolveRoles(
      { reviewModel: "p-review" },
      { reviewModel: "g-review", deepModel: "g-deep" },
    );
    expect(roles.reviewer).toEqual({ model: "p-review", source: "project" });

    const globalWins = resolveRoles({}, { reviewModel: "g-review", deepModel: "g-deep" });
    expect(globalWins.reviewer).toEqual({ model: "g-review", source: "global" });

    const slot = resolveRoles({}, { deepModel: "g-deep" });
    expect(slot.reviewer).toEqual({ model: "g-deep", source: "slot" });
  });

  test("project slot beats global slot", () => {
    const roles = resolveRoles({ deepModel: "p-deep", fastModel: "p-fast" }, { deepModel: "g-deep", fastModel: "g-fast" });
    expect(roles.deep).toEqual({ model: "p-deep", source: "project" });
    expect(roles.reviewer).toEqual({ model: "p-deep", source: "project" });
    expect(roles.worker).toEqual({ model: "p-fast", source: "project" });
  });

  test("workerModel pin seeds the deep slot: pre-slot projects behave identically", () => {
    const roles = resolveRoles({ workerModel: "legacy" }, {});
    expect(roles.worker).toEqual({ model: "legacy", source: "project" });
    expect(roles.reviewer).toEqual({ model: "legacy", source: "project" });
    expect(roles.debugger).toEqual({ model: "legacy", source: "project" });
    expect(roles.orchestrator).toEqual({ model: "legacy", source: "project" });
  });

  test("global slots beat the project workerModel pin for derived roles, not for worker", () => {
    const roles = resolveRoles({ workerModel: "legacy" }, { deepModel: "d", fastModel: "f" });
    expect(roles.worker).toEqual({ model: "legacy", source: "project" });
    expect(roles.reviewer).toEqual({ model: "d", source: "slot" });
    expect(roles.orchestrator).toEqual({ model: "d", source: "slot" });
    expect(roles.debugger).toEqual({ model: "d", source: "slot" });
  });

  test("orchestrator and debugger explicit overrides resolve independently", () => {
    const roles = resolveRoles(
      { orchestratorModel: "p-orch", debugModel: "p-dbg" },
      { deepModel: "d" },
    );
    expect(roles.orchestrator).toEqual({ model: "p-orch", source: "project" });
    expect(roles.debugger).toEqual({ model: "p-dbg", source: "project" });
    expect(roles.reviewer).toEqual({ model: "d", source: "slot" });
  });
});

describe("mergeConfigs", () => {
  test("project keys win, global fills the gaps", () => {
    expect(mergeConfigs({ workerModel: "p" }, { workerModel: "g", deepModel: "d" })).toEqual({
      workerModel: "p",
      deepModel: "d",
    });
  });
});

describe("escalationReason", () => {
  test("attempt ≥ 2 or Effort: hi escalates", () => {
    expect(escalationReason(1, "hi")).toBe("effort");
    expect(escalationReason(2, undefined)).toBe("attempt");
    expect(escalationReason(3, "lo")).toBe("attempt");
    expect(escalationReason(1, "med")).toBeNull();
    expect(escalationReason(1, "lo")).toBeNull();
    expect(escalationReason(1, undefined)).toBeNull();
    expect(escalationReason(Number.NaN, "hi")).toBe("effort");
  });
});
