# HARP-1: Debugger harness-fix lane (agent handoff)

## Goal

Make the ompo debugger session capable of fixing **harness / environment
bugs** (e.g. `Playwright.webServer` 502 because `NO_PROXY` isn't set) so the
team-of-agents becomes self-sufficient and `done=2 failed=0` instead of
`blocked-env` forever. The debugger must be able to commit a one-line fix to
the project's base checkout (not the worktree), re-run the gate, and report.

This is a **build spec**, not a design debate. All constants, functions, and
test cases below are ready to implement.

## Background: why the current debugger can't do this

Current behavior (proven by the s2b run):
- The debugger runs in the slice **worktree** (`ompo/<run>/s2b-company-ui`,
  a git branch `ompo/.../s2b-company-ui` branched from the base commit).
- `worktree.merge()` merges the worktree branch into the **main checkout**
  (projectDir). Shared state (`.env`, `node_modules`) is symlinked, not
  committed.
- The proxy bug is a bug in `e2e/playwright.config.ts` — a file that lives in
  the repo base, not in the slice's worktree. A fix to that file would be
  committed to the *worktree branch*, and would NOT merge through to base
  unless it's on the base line (it isn't) — actually the worktree branch
  *can* merge a change to a base file, but the existing `commitWork` excludes
  shared state only; it does NOT exclude harness files, so a base-file edit
  in the worktree *would* merge. **The real blocker is that the debugger was
  explicitly told (debug.ts:138) to STOP on environmental failures** and the
  env-triage `classifyEnvFailure()` matched the proxy 502's "connection
  refused" signature, parking the slice as `blocked-env` without invoking the
  debugger at all — see loop.ts:550-557, and debug.test.ts which asserts
  `debugCalls === 0` for env matches.

So the fix is **two parts**: (1) let the debugger *recognize and own* the
"environmental on the surface, harness bug underneath" class, and (2) give
it a sanctioned path to commit to base.

## Design

### 1. New marker + contract

Add a machine-parsable harness-fix marker to the debugger's completion
report. The debugger prints a `<<<OMPO_HARNESS_FIX>>>` block (new prefix in
`report.ts`) containing:

```json
{
  "sliceId": "<id matches the run report>",
  "filesPatched": ["e2e/playwright.config.ts"],
  "diff": "<unified diff, MAX 40 lines, ONLY touching files NOT in the slice files list>",
  "summary": "<5-20 words, why the harness bug broke this slice's gate>"
}
```

- **`filesPatched`**: repo-relative paths, all must exist on `main`/HEAD.
- **`diff`**: a unified diff the orchestrator applies with `git apply` to the
  base checkout (`projectDir`). No `-p1`/`-p0` guessing — use
  `git apply --3way` (falls back to merge) then `git add -A` on the listed
  files only. If apply fails, the harness fix is rejected (debugger goes to
  retry path, fix must be hand-reconciled).
- **Strict rails**:
  - `diff` must be ≤ 40 lines (debug.ts).
  - Every file in `filesPatched` must **not** be in the slice's declared
    `files` list (slice files = in-scope for the worker; harness files =
    out-of-scope, that's the whole point).
  - Every file in `filesPatched` must be dirty-able on base: must exist at
    HEAD (`git cat-file -e HEAD:<file>`).
  - The orchestrator **must also** sanity-check `git status` of base is clean
    before applying (no clobbering real uncommitted work). If base is dirty,
    reject the patch and bail to retry — do NOT `--amend` or force anything.

### 2. Wire it into the loop (src/loop.ts)

In `runDebugger()`, after extracting the report and checking `dreport.done`:

1. If the report contains a `<<<OMPO_HARNESS_FIX>>>` block, parse it into a
   `HarnessFix` object (new interface in `report.ts`).
2. Run **rail validation** (diff length, file scope, file existence at HEAD,
   base-cleanliness). Collect ALL violations, don't short-circuit.
3. If any rail fails → reject: write
   `slices/<id>/debug-<n>.harness-fix-rejected.json` with the violations,
   log `debugger: harness-fix rejected — <reasons>` (NOT "done"), and return
   `false` from `runDebugger` (so the normal retry-or-terminal path runs).
   The debugger does NOT get to keep going; one shot.
4. If rails pass → apply with `git -C projectDir apply --3way -- <patch>`
   where patch is the `diff` written to a temp file. Use `spawnSync` from
   `node:child_process` (already available in `worktree.ts`).
5. `git -C projectDir add -- <filesPatched joined>`. Do NOT commit here —
   the worktree's own `commitWork`/`merge` path handles base commits.
   Actually: the harness fix touches base files directly in `projectDir`,
   NOT the worktree. So `runAttempt`'s `runGate("verify")` already runs in
   `wtPath`... we must run the harness patch against `projectDir` (base) and
   then the verify gate in the **worktree**, which inherits the symlinked
   shared state but reads the patched file from... the worktree branch.
   **Decision: patch BOTH.** Apply `git apply` to `projectDir`, then
   `git -C projectDir cherry-pick <worktree-branch>` onto a temp branch, OR
   simpler: apply to the worktree's checked-out files too (worktree is a
   separate checkout of the same repo; a file edit in worktree is visible
   there). Use: `git -C wtPath apply --3way -- <patch>`. The worktree is the
   verify cwd, so its files must contain the patch. Also apply to projectDir
   so it's not lost. See "Implementation note: which checkout" below.
6. Log `  harness fix applied: <filesPatched>` and write
   `.patch-applied` artifact next to the debug log.
7. Return a *special* true — the gate WILL be re-run (because the patch
   changes verify behavior), but do NOT treat it as "debugger fixed" via
   the normal `return true` path that skips re-verify. Instead: return
   `{ reverify: true }` or use a side channel. 
   **Simplest**: change `runDebugger` return type from `Promise<boolean>` to
   `Promise<"fixed" | "harness" | false>` where `"harness"` means "apply
   patch, re-run verify via the existing debugger-changed-gate path."
   Implementation: keep `return true` semantics but BEFORE returning true in
   the harness case, set a module-level `appliedHarnessFix = true`; in the
   caller (loop.ts:563-570), when `debugged` is true, re-run the gate as
   normal. This works with the existing code with minimal change.
8. The existing gate re-run at loop.ts:567 already runs verify in the
   worktree — if the patch was applied to the worktree, it'll pass.

### 3. New functions / edits

**`src/report.ts`** — add:
- `export const HARNESS_OPEN = "<<<OMPO_HARNESS_FIX";`
- `export const HARNESS_CLOSE = ">>>";`
- `export interface HarnessFix { sliceId: string; filesPatched: string[]; diff: string; summary: string; }`
- `export function extractHarnessFix(output: string): HarnessFix | undefined`
  (same pattern as `extractReportFromOutput`).
- `export function reportBlockSkeleton` — add a harness-fix section commented
  out in the skeleton, so workers know the shape.

**`src/debug.ts`** — edits:
- `buildDebugPrompt()`: in the Contract, add a 6th rule:
  > `5b. If the failure is environmental on the surface but is caused by a BUG IN
  > THE HARNESS / verify plumbing itself (e.g. a Playwright webServer polling
  > through an un-bypassed proxy → 502; a stale DATABASE_URL in the gate; a
  > verify command with a wrong port — i.e. the *tooling* between you and the
  > slice is broken, not your code), you may emit a harness fix: keep
  > `done: true`, AND append a <<<OMPO_HARNESS_FIX {...} >>> block with
  > `filesPatched` (repo files only, NOT this slice's declared Files list),
  > `diff` (unified, ≤40 lines, base-clean only), and `summary`. The patch is
  > applied to the worktree + base on your behalf before the gate re-runs. If the
  > fix truly is environmental (dead DB, squatted port you can't fix in code),
  > STOP and report done=false with verificationNotes — do not paper over it.`
- Add rail validators as pure exported functions for testing:
  - `export function validateHarnessFix(hf: HarnessFix, sliceFiles: string[], allFilesAtHead: Set<string>): string[]`
    returns `[]` if OK, else list of violation strings.
    Rules: empty filesPatched → "filesPatched required";
    filesPatched ∩ sliceFiles not empty → "cannot patch slice-owned files";
    files not in allFilesAtHead → "file not at HEAD";
    diff line count > 40 → "diff exceeds 40 lines";
  - `export const MAX_HARNESS_DIFF_LINES = 40;`

**`src/loop.ts`** — edits:
- In `runDebugger()`, after `validateCompletionReport` and the `!dreport.done` check, add:
  ```ts
  const harness = extractHarnessFix(rawStdout);
  if (harness) {
    writeFileSync(join(dir, `debug-${attempt}.harness-fix.json`), JSON.stringify(harness, null, 2) + "\n");
    const violations = validateHarnessFix(harness, claimed.files, headFileSet(projectDir));
    if (violations.length) {
      writeFileSync(join(dir, `debug-${attempt}.harness-fix-rejected.json`),
        JSON.stringify({ harness, violations }, null, 2) + "\n");
      log(ctx, summarize5(claimed, `debugger: harness-fix rejected — ${violations.join("; ")}`, dreport, undefined));
      return false; // retry-or-terminal path
    }
    // apply to worktree (verify cwd) and base
    applyHarnessFix(projectDir, wtPath, harness, attempt);
    log(ctx, `  harness fix applied: ${harness.filesPatched.join(", ")}`);
    return true; // re-run the gate via existing path
  }
  ```
  (If both `done:true` report AND a harness block exist, patch applies then gate re-runs; if only harness block without done:true, treat as inconclusive → return false.)

- Add helpers (top-level, near `failAttempt`/`preserveIncompleteWork`):
  - `headFileSet(projectDir: string): Set<string>` — `git -C projectDir ls-tree -r --name-only HEAD` split to set.
  - `applyHarnessFix(projectDir, wtPath, hf, attempt): void` — writes diff to
    temp file, runs `git apply --3way` on both projectDir and wtPath (best
    effort; if one fails, clean up / abort). `git add -A -- <files>` on both.
    Uses `spawnSync` (sync, in scope). On failure: throw → caught by existing
    try/catch in runDebugger? **No** — runDebugger's try/catch wraps the
    `ctx.runner(...)` call, not post-report logic. Move the harness
    extraction+apply into the `try` block, OR add its own try/catch that
    writes an artifact and returns false on apply failure. Use its own
    try/catch.

### 4. Implementation note: which checkout?

`e2e/playwright.config.ts` is a **single file** with the same content in both
the worktree branch and the base branch (the worktree was branched from base
HEAD and no prior slice touched that file). Editing it in the **worktree**
(`wtPath`) is what makes the verify gate (which runs in wtPath) see the fix.
Editing it in **base** (`projectDir`) is what makes the fix persist past the
worktree. Apply to both; they're the same file so no merge conflict. If a
future slice already changed that file, `git apply --3way` merges cleanly.

**Verification:** the probe spec `e2e/zz-proxy-probe.spec.ts` already proves
the patched config (with `NO_PROXY` forcing) makes the webServer poller pass
in 6.8s instead of 120s-timeout. After the harness fix lands, a re-run of
the s2b Verify command should hit that path (the probe is deleted by the
worker; the real gate is the full s2-company-onboarding batch).

### 5. Tests (tests/debug.test.ts)

Add `describe("harness fix")`:
- `extractHarnessFix` finds the block among verbose stdout, returns undefined if none.
- `validateHarnessFix` rejects:
  - empty `filesPatched`
  - a file that is in the slice `files` list
  - a file not in the HEAD set
  - `diff` over 40 lines
  - non-`filesPatched` keys ignored / required fields missing
- `validateHarnessFix` accepts a valid block with base-only files.
- Integration (loop.test.ts): a runner emits `done:true` + harness fix block
  for a slice with empty `Files:` list and a `Verify: node -e "throw new
  Error('proxy 502')"`; assert `git apply` was invoked (spy on spawnSync or
  assert the patched file changed) and the gate re-ran. (May need mocking —
  mark as `test.fails` if git apply in tmp is flaky.)

### 6. AGENTS.md (project-local, not ompo)

Add to the General WMS `AGENTS.md` (one line under the Debugger section
placeholder):

> **Harness bugs:** if the debugger proves the *orchestration harness* (e.g.
> Playwright proxy 502, stale DB URL in a Verify command) broke the slice and
> the fix is a small in-repo patch, emit a `<<<OMPO_HARNESS_FIX>>>` block.
> The loop validates & applies it (base + worktree) and re-runs the gate.

## Acceptance

- `bun test` passes (existing tests + new harness-fix tests).
- `bunx tsc --noEmit` clean.
- `git diff --check` clean in ompo repo.
- Re-running the *current* blocked run (`20260906-wtuc2a`, which has the
  fixed `PORT=3100` Verify lines) via `ompo resume` — with the harness fix
  applied to `e2e/playwright.config.ts` — should NOT park s2b as
  `blocked-env`. It should let the debugger run, the debugger should apply
  the `NO_PROXY` patch, and the gate should pass.

## Out of scope

- No new CLI flags. Harness fix is always-on when the debugger emits the
  block.
- No interactive mode. If rails fail, it's a hard rejection → retry path.
- Does not change `maxRetries`, `debugTimeoutSec`, or the env-triage
  `classifyEnvFailure` (that still catches dead Postgres, squatted ports,
  etc. — those genuinely need a human/resume).

## Command reference (for the implementing agent)

```bash
cd <ompo checkout>
bun test          # tests/loop.test.ts tests/debug.test.ts
bunx tsc --noEmit
# After applying ompo changes locally to the general-wms worktree:
#   the s2b slice's worktree already has the proxy fix from commit 741be30;
#   the remaining gap is ompo's own harness-fix lane letting the
#   debugger re-apply it when env triage currently swallows it.
```
