/**
 * Test preload: pin the global config home to a throwaway dir so a
 * developer's real ~/.config/ompo/config.yml never changes test outcomes.
 * Tests that exercise global resolution pass explicit env/home locations.
 *
 * Bun does not forward `process.env` mutations to child processes, so this
 * pin never reaches a spawned CLI: any test that spawns one must pass the
 * env explicitly (see the pinned `cli()` helpers in sprint3 / release-gate),
 * or the child reads the developer's real config and live-probes models.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["OMPO_CONFIG_HOME"]) {
  process.env["OMPO_CONFIG_HOME"] = mkdtempSync(join(tmpdir(), "ompo-test-config-"));
}
