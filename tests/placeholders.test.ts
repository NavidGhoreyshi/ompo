import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractMissingVar,
  isDeploySlice,
  loadPlaceholders,
  placeholderFor,
  placeholdersDocRef,
  recordPlaceholder,
} from "../src/placeholders.ts";

describe("extractMissingVar", () => {
  test("quoted var in the triage reason wins", () => {
    expect(extractMissingVar('missing env var "SEED_ADMIN_PASSWORD"', ["anything"])).toBe(
      "SEED_ADMIN_PASSWORD",
    );
  });

  test("scans output tails for must-be-set and shell forms", () => {
    expect(extractMissingVar("required env var missing", ["Error: FOO_BAR must be set to run"])).toBe(
      "FOO_BAR",
    );
    expect(
      extractMissingVar("required env var missing", ["BAZ_QUX: parameter null or not set"]),
    ).toBe("BAZ_QUX");
    expect(
      extractMissingVar("required env var missing", ['missing environment variable "QUUX_CORGE"']),
    ).toBe("QUUX_CORGE");
  });

  test("null when no name is identifiable", () => {
    expect(extractMissingVar("required env var missing", ["something vague happened"])).toBeNull();
    expect(extractMissingVar("port already in use", ["EADDRINUSE"])).toBeNull();
  });
});

describe("placeholderFor", () => {
  test("password-shaped vars get policy-safe values", () => {
    const v = placeholderFor("SEED_ADMIN_PASSWORD");
    expect(v.length).toBeGreaterThanOrEqual(12);
    expect(v).toMatch(/[A-Z]/);
    expect(v).toMatch(/[a-z]/);
    expect(v).toMatch(/[0-9]/);
    expect(v).toMatch(/[^A-Za-z0-9]/);
  });

  test("url/host/port/database shapes", () => {
    expect(placeholderFor("DATABASE_URL")).toBe("postgresql://localhost:5432/ompo_dev");
    expect(placeholderFor("BASE_URL")).toBe("http://localhost:3000");
    expect(placeholderFor("APP_PORT")).toBe("3000");
    expect(placeholderFor("DB_HOST")).toBe("localhost");
  });

  test("deterministic shell-safe default", () => {
    expect(placeholderFor("FOO")).toBe(placeholderFor("FOO"));
    expect(placeholderFor("SOME_THING")).toBe("ompo-dev-some-thing");
  });
});

describe("record/load placeholders", () => {
  test("round-trips and renders a swap doc; first write wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-ph-"));
    recordPlaceholder(dir, "r", {
      name: "SEED_ADMIN_PASSWORD",
      value: "v1",
      firstSeenSlice: "a",
      firstSeenAttempt: 1,
      at: "t",
    });
    expect(loadPlaceholders(dir, "r")["SEED_ADMIN_PASSWORD"]?.firstSeenSlice).toBe("a");
    const md = readFileSync(join(dir, ".omp", "roadmap", "runs", "r", "placeholders.md"), "utf8");
    expect(md).toContain("DEV-ONLY");
    expect(md).toContain("SEED_ADMIN_PASSWORD");
    expect(placeholdersDocRef("r")).toContain("placeholders.md");
    recordPlaceholder(dir, "r", {
      name: "SEED_ADMIN_PASSWORD",
      value: "v2",
      firstSeenSlice: "b",
      firstSeenAttempt: 2,
      at: "t2",
    });
    expect(loadPlaceholders(dir, "r")["SEED_ADMIN_PASSWORD"]?.value).toBe("v1");
  });
});

describe("isDeploySlice", () => {
  test("matches deploy in id or title only", () => {
    expect(isDeploySlice("deploy", "Ship it")).toBe(true);
    expect(isDeploySlice("s9", "Final deploy to prod")).toBe(true);
    expect(isDeploySlice("s3b-ui", "Warehouses UI")).toBe(false);
  });
});
