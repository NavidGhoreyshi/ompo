import { describe, expect, test } from "bun:test";
import { activityColor, activityRows, createLogBus, fitLogTail, formatActivityLine, logLineColor, logWindow, stripAnsi, truncateMiddle, wrapLogLine } from "../src/run.tsx";

describe("log bus", () => {
  test("splits newlines into rows, strips ANSI, drops blanks", () => {
    const bus = createLogBus();
    bus.push(`first\u001b[31m line\u001b[0m\n\nsecond`);
    expect(bus.lines).toEqual(["first line", "second"]);
  });

  test("capped at maxLines, newest kept", () => {
    const bus = createLogBus(3);
    for (const n of [1, 2, 3, 4]) bus.push(`line ${n}`);
    expect(bus.lines).toEqual(["line 2", "line 3", "line 4"]);
  });

  test("subscribe notifies on push and unsubscribe stops it", () => {
    const bus = createLogBus();
    let calls = 0;
    const off = bus.subscribe(() => calls++);
    bus.push("a");
    expect(calls).toBe(1);
    bus.push("b");
    expect(calls).toBe(2);
    off();
    bus.push("c");
    expect(calls).toBe(2);
  });
});

describe("log coloring", () => {
  test("outcome lines get semantic colors", () => {
    expect(logLineColor("verify ok: bun test")).toBe("green");
    expect(logLineColor("run finished: done=1 failed=0")).toBe("green");
    expect(logLineColor("verify FAIL")).toBe("red");
    expect(logLineColor("slice_failed_terminal")).toBe("red");
    expect(logLineColor("environment blocked: port 3000")).toBe("magenta");
    expect(logLineColor("retrying (1/2 retries used)")).toBe("yellow");
    expect(logLineColor("… a still running (2m elapsed)")).toBe("gray");
    expect(logLineColor("  summary: did the thing")).toBe("gray");
    expect(logLineColor("[a] turn 1…")).toBe("cyan");
    expect(logLineColor("plain")).toBeUndefined();
  });
});

describe("stripAnsi", () => {
  test("removes color codes only", () => {
    expect(stripAnsi("\u001b[32mgreen\u001b[0m plain")).toBe("green plain");
  });
});

describe("fitLogTail", () => {
  test("returns newest lines that fit the row budget", () => {
    const lines = ["one", "two", "three"];
    // Every line is 1 row at this width; height 2 keeps the two newest.
    expect(fitLogTail(lines, 2, 80)).toEqual(["two", "three"]);
  });

  test("long lines consume multiple rows (conservative wrap estimate)", () => {
    const lines = ["short", "x".repeat(200), "tail"];
    // 200 chars at width 80 → ceil(200/74) = 3 rows. Tail is the newest: at
    // height 3 it fits alone but not with the long line (would be 4 rows).
    expect(fitLogTail(lines, 3, 80)).toEqual(["tail"]);
    expect(fitLogTail(lines, 4, 80)).toEqual(["x".repeat(200), "tail"]);
    // Height 5 (4 used + 1) admits "short" too.
    expect(fitLogTail(lines, 5, 80)).toEqual(["short", "x".repeat(200), "tail"]);
  });

  test("ignores empty/blank rows", () => {
    expect(fitLogTail(["", "  ", "a"], 1, 80)).toEqual(["a"]);
  });
});

describe("wrapLogLine", () => {
  test("splits at pane width, drops blanks", () => {
    expect(wrapLogLine("ab", 80)).toEqual(["ab"]);
    expect(wrapLogLine("x".repeat(150), 80)).toEqual(["x".repeat(74), "x".repeat(74), "x".repeat(2)]);
    expect(wrapLogLine("   ", 80)).toEqual([]);
  });
});

describe("logWindow", () => {
  test("stuck to tail shows newest rows that fit", () => {
    expect(logWindow(["one", "two", "three"], 2, 80, 0).shown).toEqual(["two", "three"]);
  });

  test("scrollUp lifts into history with clamped offset", () => {
    const w = logWindow(["one", "two", "three"], 2, 80, 1);
    expect(w.shown).toEqual(["one", "two"]);
    expect(w.offset).toBe(1);
    expect(w.totalRows).toBe(3);
    expect(w.maxScroll).toBe(1);
    const over = logWindow(["one", "two", "three"], 2, 80, 99);
    expect(over.offset).toBe(1);
    expect(over.shown).toEqual(["one", "two"]);
  });

  test("long lines wrap into multiple visual rows", () => {
    const lines = ["short", "x".repeat(200), "tail"];
    // 200 chars → 3 visual rows at width 80; 5 rows total.
    const tail = logWindow(lines, 2, 80, 0);
    expect(tail.totalRows).toBe(5);
    expect(tail.shown).toEqual(["x".repeat(52), "tail"]);
    expect(logWindow(lines, 2, 80, 2).shown).toEqual(["x".repeat(74), "x".repeat(74)]);
  });
});

describe("formatActivityLine", () => {
  test("tool rows collapse to $ kind + middle-truncated command", () => {
    const cmd = `docker tag node:20-bookworm-slim node:20-slim --extra ${"x".repeat(120)}`;
    const row = formatActivityLine(`[s1-deploy-a] tool bash: ${cmd}`, 80);
    expect(row.startsWith("$ bash docker tag")).toBe(true);
    expect(row.length).toBeLessThanOrEqual(74);
    expect(row).toContain("…");
  });
  test("session tags bracket out of the command", () => {
    const row = formatActivityLine("[s1-deploy-b review] tool bash: docker images", 80);
    expect(row).toBe("$ bash [review] docker images");
  });
  test("turn rows become dimmable · markers, says rows quote", () => {
    expect(formatActivityLine("[a] turn 12 done (3 tool results)", 80)).toBe("· a turn 12 done (3 tool results)");
    expect(formatActivityLine("[a review] turn 5…", 80)).toBe("· a review turn 5…");
    expect(formatActivityLine("[a] says: wiring this up", 80)).toBe("» a wiring this up");
  });

  test("state lines pass through, truncated to the pane", () => {
    expect(formatActivityLine("run finished: done=2 failed=0", 80)).toBe("run finished: done=2 failed=0");
    const long = `  placeholder: ${"y".repeat(200)}`;
    expect(formatActivityLine(long, 80).length).toBeLessThanOrEqual(74);
  });
});

describe("truncateMiddle + activityColor", () => {
  test("keeps head and tail of long commands", () => {
    const t = truncateMiddle(`docker compose up -d --build ${"z".repeat(100)} --timeout 30`, 40);
    expect(t.length).toBe(40);
    expect(t.startsWith("docker compose")).toBe(true);
    expect(t.endsWith("--timeout 30")).toBe(true);
  });

  test("turn markers dim, tool rows keep stream color", () => {
    expect(activityColor("· a turn 12 done")).toBe("gray");
    expect(activityColor("$ bash docker ps")).toBeUndefined();
  });
});

describe("activityRows", () => {
  test("capped low, floored for short terminals", () => {
    expect(activityRows(40)).toBe(9);
    expect(activityRows(24)).toBe(6);
    expect(activityRows(16)).toBe(3);
  });
});
