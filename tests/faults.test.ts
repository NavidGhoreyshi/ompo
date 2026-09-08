import { describe, expect, test } from "bun:test";
import {
  faultsArmed,
  mulberry32,
  parseFaultSpec,
  seedSuffix,
  shouldAbortAttempt,
  shouldCrashAfter,
  shouldFailVerify,
} from "../src/faults.ts";

describe("parseFaultSpec", () => {
  test("parses a full spec", () => {
    const s = parseFaultSpec("fail-verify=s2+s3,abort-attempt=0.25,crash-after=5");
    expect(s.failVerify).toEqual(["s2", "s3"]);
    expect(s.abortAttempt).toBe(0.25);
    expect(s.crashAfter).toBe(5);
  });

  test("partials and whitespace are fine", () => {
    expect(parseFaultSpec("crash-after=1")).toEqual({ failVerify: [], abortAttempt: 0, crashAfter: 1 });
  });

  test("malformed specs throw with the offending clause", () => {
    expect(() => parseFaultSpec("")).toThrow(/needs a spec/);
    expect(() => parseFaultSpec("explode=1")).toThrow(/unknown fault key/);
    expect(() => parseFaultSpec("abort-attempt=2")).toThrow(/0\.\.1/);
    expect(() => parseFaultSpec("abort-attempt=nope")).toThrow(/0\.\.1/);
    expect(() => parseFaultSpec("crash-after=0")).toThrow(/positive integer/);
    expect(() => parseFaultSpec("fail-verify=")).toThrow(/at least one slice/);
  });
});

describe("fault predicates", () => {
  test("armed only when something is set", () => {
    expect(faultsArmed({ failVerify: [], abortAttempt: 0 })).toBe(false);
    expect(faultsArmed({ failVerify: ["a"], abortAttempt: 0 })).toBe(true);
    expect(faultsArmed({ failVerify: [], abortAttempt: 0.5 })).toBe(true);
    expect(faultsArmed({ failVerify: [], abortAttempt: 0, crashAfter: 1 })).toBe(true);
  });

  test("fail-verify matches listed slices only", () => {
    const s = parseFaultSpec("fail-verify=s2");
    expect(shouldFailVerify(s, "s2")).toBe(true);
    expect(shouldFailVerify(s, "s3")).toBe(false);
  });

  test("crash tripwire fires at the count, never before", () => {
    const s = parseFaultSpec("crash-after=3");
    expect(shouldCrashAfter(s, 2)).toBe(false);
    expect(shouldCrashAfter(s, 3)).toBe(true);
    expect(shouldCrashAfter(s, 9)).toBe(true);
  });

  test("seeded RNG replays identically; abort draws honor probability", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect(Array.from({ length: 5 }, () => a())).toEqual(Array.from({ length: 5 }, () => b()));
    expect(mulberry32(7)()).not.toBe(mulberry32(8)());
    const spec = parseFaultSpec("abort-attempt=1");
    expect(shouldAbortAttempt(spec, mulberry32(1))).toBe(true);
    const off = parseFaultSpec("crash-after=1");
    expect(shouldAbortAttempt(off, () => 0)).toBe(false);
  });

  test("seed suffix correlates without breaking uniqueness inputs", () => {
    expect(seedSuffix(undefined)).toBe("");
    expect(seedSuffix(7)).toBe("-s7");
  });
});
