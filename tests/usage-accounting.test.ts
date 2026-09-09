import { describe, expect, test } from "bun:test";
import { formatCostUsd, sumUsages } from "../web/src/components/Usage.tsx";
import { usageForEvent } from "../src/worker.ts";

// Real `--mode json` envelope shape, verified against live omp 18.1.14
// output (see usageForEvent tests in tests/worker.test.ts): totalTokens =
// input+output+cacheRead+cacheWrite, reasoningTokens is a sub-count of
// output, cost.total is authoritative USD.
const ENVELOPE = {
  input: 18348,
  output: 17,
  cacheRead: 241,
  cacheWrite: 0,
  totalTokens: 18606,
  reasoningTokens: 6,
  cost: { input: 0.0018348, output: 0.0000034, cacheRead: 4.82e-7, cacheWrite: 0, total: 0.001838682 },
};

function parsed(extra?: Record<string, unknown>) {
  const usage = { ...ENVELOPE, ...extra };
  return usageForEvent({ type: "message_end", message: { role: "assistant", usage } })!;
}

describe("usage accounting helpers", () => {
  test("full envelope parses to the six displayed fields", () => {
    const u = parsed();
    expect(u.input).toBe(18348);
    expect(u.output).toBe(17);
    expect(u.cacheRead).toBe(241);
    expect(u.reasoningTokens).toBe(6);
    expect(u.total).toBe(18606);
    expect(u.cost?.total).toBe(0.001838682);
  });

  test("reasoning is a sub-count of output, not additive to the total", () => {
    const u = parsed();
    expect(u.total).toBe(u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
    expect(u.reasoningTokens!).toBeLessThanOrEqual(u.output);
  });

  test("formatCostUsd renders authoritative USD, never an estimate", () => {
    expect(formatCostUsd(0.001838682)).toBe("$0.0018");
    expect(formatCostUsd(1.5)).toBe("$1.50");
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(undefined)).toBe("—");
  });

  test("legacy envelopes without cache/cost stay subset-shaped", () => {
    const u = usageForEvent({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50 } },
    })!;
    expect(u.cacheRead).toBeUndefined();
    expect(u.reasoningTokens).toBeUndefined();
    expect(u.cost).toBeUndefined();
    expect(formatCostUsd(u.cost?.total)).toBe("—");
  });

  test("sumUsages adds generation sessions, preserves unknown fields", () => {
    const full = parsed();
    const legacy = usageForEvent({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50 } },
    })!;
    const sum = sumUsages([full, legacy, undefined])!;
    expect(sum.input).toBe(18448);
    expect(sum.output).toBe(67);
    expect(sum.total).toBe(18606 + 150);
    // Only the full envelope reported cache/cost: sums reflect that alone.
    expect(sum.cacheRead).toBe(241);
    expect(sum.reasoningTokens).toBe(6);
    expect(sum.cost?.total).toBeCloseTo(0.001838682, 9);
  });

  test("sumUsages is undefined with no envelopes, sparse without zero-fill", () => {
    expect(sumUsages([undefined, undefined])).toBeUndefined();
    expect(sumUsages([])).toBeUndefined();
    const legacy = usageForEvent({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50 } },
    })!;
    const sum = sumUsages([legacy])!;
    expect(sum.cacheRead).toBeUndefined();
    expect(sum.cost).toBeUndefined();
  });
});
