#!/usr/bin/env bun
/**
 * Deck workflow e2e fixture host: the real dashboard server, in its own bun
 * process, for `tests/e2e/deck-workflow.e2e.ts`.
 *
 * Why a child process rather than `startDashboardServer` inside the spec:
 * `src/server.ts` imports `../package.json`, which Node's ESM loader refuses
 * without an import attribute — so the spec's own process (Playwright's Node
 * loader) cannot pull the server in. bun reads it as the shipped code does, and
 * the spec keeps owning the lifecycle (`spawn` in `beforeAll`, `SIGTERM` in
 * `afterAll`) and keeps driving the run through `storeApi` directly.
 *
 * Prints one machine-readable line when the port is bound, then stays up until
 * the parent kills it.
 */

import { startDashboardServer } from "../../src/server.ts";

function argOf(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const projectDir = argOf("--project-dir", "");
if (!projectDir) {
  console.error("deck-workflow-harness: --project-dir is required");
  process.exit(2);
}
const port = Number(argOf("--port", "4471"));

const server = startDashboardServer({ projectDir, port });
console.log(
  `deck-workflow-harness ${JSON.stringify({ projectDir, url: server.url, port: server.port, assetMode: server.assetMode })}`,
);

const { promise } = Promise.withResolvers<void>();
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});
await promise;
