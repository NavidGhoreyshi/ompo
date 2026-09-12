/**
 * Test preload: pin the global config home to a throwaway dir so a
 * developer's real ~/.config/ompo/config.yml never changes test outcomes.
 * Tests that exercise global resolution pass explicit env/home locations.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["OMPO_CONFIG_HOME"]) {
  process.env["OMPO_CONFIG_HOME"] = mkdtempSync(join(tmpdir(), "ompo-test-config-"));
}
