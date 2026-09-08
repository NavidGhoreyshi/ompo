import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  explainConfig,
  runDoctor,
  type DoctorProbes,
} from "../src/doctor.ts";
import { parseRoadmap } from "../src/parse.ts";
import { createRun, sliceDir, storeApi } from "../src/store.ts";

const YML = `workerModel: test-model
reviewModel: review-model
maxRetries: 2
modelFallbacks:
  - fallback-a
  - fallback-b
verifyDefaults:
  - bun test
`;

const ROADMAP = `## [a] First slice
Do X.
Verify: echo ok
Files: src/a.ts

## [b] Second slice
Do Y.
Agent: special-agent
Verify: echo ok2
`;

function files(extra?: {
  yml?: string | null;
  roadmap?: string | null;
}): Pick<DoctorProbes, "readFile" | "exists"> {
  const yml = extra?.yml === undefined ? YML : extra.yml;
  const roadmap = extra?.roadmap === undefined ? ROADMAP : extra.roadmap;
  return {
    exists: (p) => {
      if (p.endsWith("roadmap.yml")) return yml !== null;
      if (p.endsWith("ROADMAP.md")) return roadmap !== null;
      return false;
    },
    readFile: (p) => {
      if (p.endsWith("roadmap.yml")) {
        if (yml === null) throw new Error("ENOENT");
        return yml;
      }
      if (p.endsWith("ROADMAP.md")) {
        if (roadmap === null) throw new Error("ENOENT");
        return roadmap;
      }
      throw new Error(`ENOENT: ${p}`);
    },
  };
}

function greenExec(
  cmd: string,
  args: string[],
): { exit: number; out: string } {
  if (cmd === "omp" && args[0] === "--version") {
    return { exit: 0, out: "omp 1.2.3\n" };
  }
  if (cmd === "omp" && args[0] === "--model") {
    return { exit: 0, out: "" };
  }
  if (cmd === "tmux") return { exit: 0, out: "tmux 3.4\n" };
  if (cmd === "git" && args.includes("--show-toplevel")) {
    return { exit: 0, out: "/tmp/proj\n" };
  }
  if (cmd === "git" && args.includes("--abbrev-ref")) {
    return { exit: 0, out: "main\n" };
  }
  if (cmd === "git" && args.includes("worktree")) {
    return { exit: 0, out: "/tmp/proj  abc1234 [main]\n" };
  }
  if (cmd === "git" && args.includes("status")) {
    return { exit: 0, out: "" };
  }
  throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
}

function greenProbes(overrides?: DoctorProbes): DoctorProbes {
  return {
    ...files(),
    exec: greenExec,
    env: {},
    diskFreeMb: () => 500,
    ...overrides,
  };
}

describe("runDoctor", () => {
  test("all-green with fake probes", async () => {
    const res = await runDoctor("/tmp/proj", greenProbes());
    expect(res.ok).toBe(true);
    expect(res.checks.map((c) => c.name)).toEqual([
      "omp",
      "models",
      "tmux",
      "git",
      "tree",
      "gates",
      "recovery",
      "disk",
      "config",
    ]);
    for (const c of res.checks) expect(c.ok).toBe(true);
  });

  test("missing omp fails the omp check and the run", async () => {
    const exec: DoctorProbes["exec"] = (cmd, args) => {
      if (cmd === "omp") return { exit: 127, out: "" };
      return greenExec(cmd, args);
    };
    const res = await runDoctor("/tmp/proj", greenProbes({ exec }));
    expect(res.ok).toBe(false);
    const omp = res.checks.find((c) => c.name === "omp")!;
    expect(omp.ok).toBe(false);
    expect(omp.fix).toContain("PATH");
  });

  test("bad yml int fails the config check", async () => {
    const res = await runDoctor(
      "/tmp/proj",
      greenProbes({ ...files({ yml: "maxRetries: banana\n" }) }),
    );
    expect(res.ok).toBe(false);
    const cfg = res.checks.find((c) => c.name === "config")!;
    expect(cfg.ok).toBe(false);
    expect(cfg.detail).toContain("maxRetries");
  });

  test("absent yml passes config with defaults", async () => {
    const res = await runDoctor(
      "/tmp/proj",
      greenProbes({ ...files({ yml: null }) }),
    );
    const cfg = res.checks.find((c) => c.name === "config")!;
    expect(cfg.ok).toBe(true);
    expect(cfg.detail).toBe("defaults");
  });

  test("missing ROADMAP.md fails the gates check", async () => {
    const res = await runDoctor(
      "/tmp/proj",
      greenProbes({ ...files({ roadmap: null }) }),
    );
    expect(res.ok).toBe(false);
    const gates = res.checks.find((c) => c.name === "gates")!;
    expect(gates.ok).toBe(false);
    expect(gates.detail).toContain("ROADMAP.md");
  });

  test("dead env refs fail gates; absent tmux and low disk fail", async () => {
    const roadmap = `## [a] First\nDo X.\nVerify: curl localhost:PORT/health\n`;
    const res = await runDoctor(
      "/tmp/proj",
      greenProbes({
        ...files({ roadmap }),
        exec: (cmd, args) => {
          if (cmd === "tmux") return { exit: 127, out: "" };
          return greenExec(cmd, args);
        },
        env: {},
        diskFreeMb: () => 42,
      }),
    );
    expect(res.ok).toBe(false);
    const gates = res.checks.find((c) => c.name === "gates")!;
    expect(gates.ok).toBe(false);
    expect(gates.detail).toContain("PORT");
    expect(gates.fix).toContain("--check-env");
    const tmux = res.checks.find((c) => c.name === "tmux")!;
    expect(tmux.ok).toBe(false);
    expect(tmux.detail).toBe("absent");
    const disk = res.checks.find((c) => c.name === "disk")!;
    expect(disk.ok).toBe(false);
    expect(disk.fix).toContain("disk");
    // ...but exporting the var heals the gate
    const healed = await runDoctor(
      "/tmp/proj",
      greenProbes({ ...files({ roadmap }), env: { PORT: "3000" } }),
    );
    expect(healed.checks.find((c) => c.name === "gates")!.ok).toBe(true);
  });

  test("unknown disk space passes as unknown; unreachable model named", async () => {
    const exec: DoctorProbes["exec"] = (cmd, args) => {
      if (cmd === "omp" && args[0] === "--model" && args[1] === "fallback-b") {
        return { exit: 1, out: "unknown model" };
      }
      return greenExec(cmd, args);
    };
    const res = await runDoctor(
      "/tmp/proj",
      greenProbes({ exec, diskFreeMb: () => null }),
    );
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.name === "disk")!).toMatchObject({
      ok: true,
      detail: "unknown",
    });
    const models = res.checks.find((c) => c.name === "models")!;
    expect(models.ok).toBe(false);
    expect(models.fix).toContain("fallback-b");
  });

  test("check never throws on hostile probes", async () => {
    const res = await runDoctor("/tmp/proj", {
      exec: () => {
        throw new Error("boom");
      },
      exists: () => {
        throw new Error("boom");
      },
      readFile: () => {
        throw new Error("boom");
      },
      env: {},
      diskFreeMb: () => {
        throw new Error("boom");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.checks).toHaveLength(9);
    for (const c of res.checks) expect(typeof c.detail).toBe("string");
  });

  test("quiescent interrupted run fails recovery with resume fix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-doctor-"));
    createRun(dir, parseRoadmap("## [a] First slice\nDo X.\nVerify: echo ok\n"), "r1");
    storeApi.claimSlice(dir, "r1", "a");
    mkdirSync(sliceDir(dir, "r1", "a"), { recursive: true });
    writeFileSync(join(sliceDir(dir, "r1", "a"), "report.json"), "{}\n", "utf8");
    const res = await runDoctor(dir, greenProbes());
    const rec = res.checks.find((c) => c.name === "recovery")!;
    expect(rec.ok).toBe(false);
    expect(rec.detail).toContain("1 interrupted slice(s) (a)");
    expect(rec.detail).toContain("saved reports");
    expect(rec.fix).toContain("ompo resume");
    expect(res.ok).toBe(false);
  });

  test("clean run passes recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-doctor-"));
    createRun(dir, parseRoadmap("## [a] First slice\nDo X.\nVerify: echo ok\n"), "r1");
    const res = await runDoctor(dir, greenProbes());
    expect(res.checks.find((c) => c.name === "recovery")!).toMatchObject({ ok: true });
  });
});

describe("explainConfig", () => {
  test("prints fallback chain and per-slice effective models", () => {
    const text = explainConfig("/tmp/proj", files());
    expect(text).toContain("test-model");
    expect(text).toContain("review-model");
    expect(text).toContain("fallback-a");
    expect(text).toContain("fallback-b");
    // Per-slice: b pins its own agent, a inherits workerModel.
    expect(text).toContain("a: test-model");
    expect(text).toContain("b: special-agent");
  });

  test("missing files report defaults without throwing", () => {
    const text = explainConfig(
      "/tmp/proj",
      files({ yml: null, roadmap: null }),
    );
    expect(text).toContain("defaults");
    expect(text).toContain("(omp default)");
    expect(text).toContain("no ROADMAP.md");
  });
});
