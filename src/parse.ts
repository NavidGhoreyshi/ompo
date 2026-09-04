/**
 * Roadmap Markdown → RoadmapDoc parser (plan §11, M1).
 *
 * Format (constrained, documented in templates/ROADMAP.example.md):
 *
 *   # Anything (H1 ignored)
 *
 *   ## [slice-id] Human title
 *   Body lines (markdown, may include H3+ subsections).
 *   Depends: other-id, another-id
 *   Agent: task
 *   Effort: med
 *   Verify: bun test -- scope
 *   Files: src/a.ts, src/b.ts
 *   Retries: 2
 *   Skip: true            # optional
 *
 * Rules:
 * - Each `## ` heading opens a slice. Content before the first `##` is ignored.
 * - `## [explicit-id] Title` pins the id; otherwise id = slug(title).
 * - Trailer lines `Key: value` (case-insensitive key) are stripped from the body.
 *   They may appear anywhere inside the slice section. `Verify:` may repeat.
 * - `Depends:` is comma/space separated. Empty = no deps.
 * - Validator rejects: zero slices, duplicate ids, unknown deps, dependency
 *   cycles (Kahn), invalid Effort / Retries values.
 */

import { createHash } from "node:crypto";
import type { Effort, RoadmapDoc, Slice } from "./types.ts";

export const DEFAULT_MAX_RETRIES = 1;

export class RoadmapParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadmapParseError";
  }
}

const TRAILER_RE =
  /^(depends|agent|effort|verify|files|retries|skip)\s*:\s*(.*)$/i;
const HEADING_RE = /^##\s+(.*)$/;
const EXPLICIT_ID_RE = /^\[([A-Za-z0-9][A-Za-z0-9._-]*)\]\s*(.*)$/;

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "slice";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface RawSlice {
  heading: string;
  lines: string[];
}

function splitSections(markdown: string): RawSlice[] {
  const out: RawSlice[] = [];
  let current: RawSlice | null = null;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const h = line.match(HEADING_RE);
    // Single-# headings never open slices; ##+ ... only exactly ## opens.
    if (h && !line.startsWith("###")) {
      current = { heading: h[1]!.trim(), lines: [] };
      out.push(current);
    } else if (current) {
      current.lines.push(rawLine.replace(/\r$/, ""));
    }
  }
  return out;
}

function parseRetries(value: string, sliceId: string): number {
  const t = value.trim();
  if (t === "") return DEFAULT_MAX_RETRIES;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    throw new RoadmapParseError(
      `slice "${sliceId}": Retries must be an integer 0..10, got "${value}"`,
    );
  }
  return n;
}

function parseEffort(value: string, sliceId: string): Effort {
  const t = value.trim().toLowerCase();
  if (t === "lo" || t === "low") return "lo";
  if (t === "med" || t === "medium") return "med";
  if (t === "hi" || t === "high") return "hi";
  throw new RoadmapParseError(
    `slice "${sliceId}": Effort must be lo|med|hi, got "${value}"`,
  );
}

function parseSkip(value: string): boolean {
  return /^(true|yes|1|skip)$/i.test(value.trim());
}

export function parseRoadmap(markdown: string): RoadmapDoc {
  const sections = splitSections(markdown);
  if (sections.length === 0) {
    throw new RoadmapParseError(
      "no slices found: expected one or more `## ` headings",
    );
  }

  const slices: Slice[] = [];
  const seen = new Map<string, number>();

  for (const sec of sections) {
    let id: string;
    let title: string;
    const m = sec.heading.match(EXPLICIT_ID_RE);
    if (m) {
      id = m[1]!;
      title = (m[2] || id).trim() || id;
    } else {
      title = sec.heading.trim() || "untitled";
      id = slugify(title);
    }
    if (seen.has(id)) {
      throw new RoadmapParseError(
        `duplicate slice id "${id}" (headings ${seen.get(id)! + 1} and ${slices.length + 1})`,
      );
    }
    seen.set(id, slices.length);

    let deps: string[] = [];
    let workerAgent: string | undefined;
    let effort: Effort | undefined;
    const verify: string[] = [];
    let files: string[] = [];
    let maxRetries = DEFAULT_MAX_RETRIES;
    let skip = false;
    const bodyLines: string[] = [];

    for (const line of sec.lines) {
      const t = line.match(TRAILER_RE);
      if (t) {
        const key = t[1]!.toLowerCase();
        const value = t[2] ?? "";
        switch (key) {
          case "depends":
            deps = value
              .split(/[,\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            break;
          case "agent":
            workerAgent = value.trim() || undefined;
            break;
          case "effort":
            effort = parseEffort(value, id);
            break;
          case "verify":
            if (value.trim()) verify.push(value.trim());
            break;
          case "files":
            files = value
              .split(/[,\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            break;
          case "retries":
            maxRetries = parseRetries(value, id);
            break;
          case "skip":
            skip = parseSkip(value);
            break;
        }
      } else {
        bodyLines.push(line);
      }
    }

    // Trim leading/trailing blank lines from body.
    while (bodyLines.length && bodyLines[0]!.trim() === "") bodyLines.shift();
    while (
      bodyLines.length &&
      bodyLines[bodyLines.length - 1]!.trim() === ""
    )
      bodyLines.pop();

    slices.push({
      id,
      title,
      body: bodyLines.join("\n"),
      deps,
      workerAgent,
      effort,
      verify,
      files,
      maxRetries,
      skip: skip || undefined,
      status: skip ? "skipped" : "pending",
      attempts: 0,
      updatedAt: new Date().toISOString(),
    });
  }

  // Unknown-dep check.
  const ids = new Set(slices.map((s) => s.id));
  for (const s of slices) {
    for (const d of s.deps) {
      if (!ids.has(d)) {
        throw new RoadmapParseError(
          `slice "${s.id}": unknown dependency "${d}"`,
        );
      }
      if (d === s.id) {
        throw new RoadmapParseError(`slice "${s.id}": depends on itself`);
      }
    }
  }

  // Cycle check (Kahn).
  const indeg = new Map<string, number>(slices.map((s) => [s.id, 0]));
  const dependents = new Map<string, string[]>(slices.map((s) => [s.id, []]));
  for (const s of slices) {
    for (const d of s.deps) {
      indeg.set(s.id, indeg.get(s.id)! + 1);
      dependents.get(d)!.push(s.id);
    }
  }
  const queue = slices
    .filter((s) => indeg.get(s.id) === 0)
    .map((s) => s.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.pop()!;
    visited++;
    for (const next of dependents.get(id)!) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== slices.length) {
    const cyclic = slices
      .filter((s) => indeg.get(s.id)! > 0)
      .map((s) => s.id);
    throw new RoadmapParseError(
      `dependency cycle involving: ${cyclic.join(", ")}`,
    );
  }

  return { version: 1, sourceHash: sha256Hex(markdown), slices };
}
