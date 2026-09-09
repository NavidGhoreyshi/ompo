#!/usr/bin/env bun
/**
 * Embed the built dashboard (`web/dist/`) into `src/webAssets.generated.ts`
 * so the compiled `ompo` binary serves the dashboard with no sibling files.
 *
 * Usage: `bun run web:build` (vite build + this script).
 * Missing `web/dist/` is not fatal — the server keeps working from disk and
 * reports 503 for `/` with the build command named.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "web", "dist");
const OUT = join(ROOT, "src", "webAssets.generated.ts");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  return "application/octet-stream";
}

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else out.push(p);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error(`embed-web: no ${relative(ROOT, DIST)}/ — run \`bunx vite build web\` first; leaving placeholder`);
  process.exit(0);
}

const entries = collect(DIST)
  .map((p) => relative(DIST, p).split(sep).join("/"))
  .sort();
const assets: Record<string, { type: string; base64: string }> = {};
for (const rel of entries) {
  const buf = readFileSync(join(DIST, rel));
  assets[rel] = { type: contentType(rel), base64: buf.toString("base64") };
}

const body = `/**
 * Embedded dashboard bundle (generated — do not edit).
 *
 * Produced by \`scripts/embed-web.ts\` (via \`bun run web:build\`) from
 * \`web/dist/*\`. The dashboard server (\`src/server.ts\`) serves these bytes
 * first and falls back to \`web/dist/\` on disk, so the compiled \`ompo\` binary
 * serves the dashboard with no sibling files.
 */
export interface EmbeddedAsset {
  /** Response Content-Type. */
  type: string;
  /** Base64-encoded body. */
  base64: string;
}

/** Built bundle version (package.json at embed time). Empty before the first build. */
export const EMBEDDED_WEB_VERSION = ${JSON.stringify(PKG.version)};

/** path → asset, paths use forward slashes (\`index.html\`, \`assets/index-abc.js\`). */
export const EMBEDDED_WEB_DIST: Record<string, EmbeddedAsset> = ${JSON.stringify(assets)};
`;

writeFileSync(OUT, body, "utf8");
const bytes = Object.values(assets).reduce((n, a) => n + Buffer.byteLength(a.base64, "utf8"), 0);
console.log(`embed-web: ${entries.length} files → ${relative(ROOT, OUT)} (${(bytes / 1024).toFixed(1)} KiB base64)`);
