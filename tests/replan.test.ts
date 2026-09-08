import { describe, expect, test } from "bun:test";
import { parseRoadmap } from "../src/parse.ts";
import { fingerprints, mergeRoadmap, replanGuards } from "../src/replan.ts";

const OLD = "## [a] Alpha\nDo alpha.\nVerify: echo a\n\n## [b] Beta\nDo beta.\nDepends: a\nVerify: echo b\n";

function doc(md: string) {
  return parseRoadmap(md);
}

describe("fingerprints", () => {
  test("identical docs fingerprint identically, edits change only theirs", () => {
    const d1 = doc(OLD);
    const d2 = doc(OLD);
    expect(fingerprints(d1)).toEqual(fingerprints(d2));
    const d3 = doc(OLD.replace("Do beta.", "Do beta differently."));
    expect(fingerprints(d3).get("a")).toBe(fingerprints(d1).get("a"));
    expect(fingerprints(d3).get("b")).not.toBe(fingerprints(d1).get("b"));
  });
});

describe("mergeRoadmap", () => {
  test("unchanged slices keep status, attempts, and refs", () => {
    const old = doc(OLD);
    old.slices[0]!.status = "done";
    old.slices[0]!.attempts = 2;
    old.slices[0]!.reportRef = "slices/a/report.json";
    old.slices[0]!.verdictRef = "slices/a/verdict.json";
    const m = mergeRoadmap(old, doc(OLD));
    expect(m.kept).toEqual(["a", "b"]);
    expect(m.reset).toEqual([]);
    const a = m.doc.slices[0]!;
    expect(a.status).toBe("done");
    expect(a.attempts).toBe(2);
    expect(a.reportRef).toBe("slices/a/report.json");
  });

  test("changed slices reset to pending with attempts preserved and refs cleared", () => {
    const old = doc(OLD);
    old.slices[1]!.status = "failed";
    old.slices[1]!.attempts = 3;
    old.slices[1]!.reportRef = "slices/b/report.json";
    const next = doc(OLD.replace("Do beta.", "Do beta with a new paragraph that changes the spec."));
    const m = mergeRoadmap(old, next);
    expect(m.kept).toEqual(["a"]);
    expect(m.reset).toEqual(["b"]);
    const b = m.doc.slices.find((s) => s.id === "b")!;
    expect(b.status).toBe("pending");
    expect(b.attempts).toBe(3);
    expect(b.reportRef).toBeUndefined();
    expect(b.verdictRef).toBeUndefined();
  });

  test("added and dropped ids are reported, sourceHash follows the new doc", () => {
    const old = doc(OLD);
    const next = doc("## [a] Alpha\nDo alpha.\nVerify: echo a\n\n## [c] Gamma\nDo gamma.\nVerify: echo c\n");
    const m = mergeRoadmap(old, next);
    expect(m.added).toEqual(["c"]);
    expect(m.dropped).toEqual(["b"]);
    expect(m.doc.sourceHash).toBe(next.sourceHash);
  });
});

describe("replanGuards", () => {
  test("live runs refuse; quiescent edits pass", () => {
    const old = doc(OLD);
    const next = doc(OLD.replace("Do alpha.", "Do alpha v2."));
    expect(replanGuards(old, next, true)).toMatch(/live/);
    expect(replanGuards(old, next, false)).toBeNull();
  });

  test("changed in-flight slices refuse with their ids", () => {
    const old = doc(OLD);
    old.slices[0]!.status = "running";
    const next = doc(OLD.replace("Do alpha.", "Do alpha v2."));
    expect(replanGuards(old, next, false)).toMatch(/a.*running/);
    // Unchanged in-flight slices are fine.
    expect(replanGuards(old, doc(OLD), false)).toBeNull();
  });

  test("changed terminal slices never block a replan", () => {
    const old = doc(OLD);
    old.slices[1]!.status = "failed";
    const next = doc(OLD.replace("Do beta.", "Do beta v2 with more words."));
    expect(replanGuards(old, next, false)).toBeNull();
  });
});
