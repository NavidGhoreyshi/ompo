# ompo Windows GUI — Sprint Roadmap

> Status: proposed sprint roadmap for a Windows-installable ompo desktop GUI
> that drives headless `omp` workers through the Windows terminal client.
>
> This roadmap builds a **Windows product**, not a second orchestrator. The
> durable store (`.omp/roadmap/`), the event log, the run loop, the control
> plane, and the deck projection stay exactly as they are on Linux. What
> changes is the process boundary: sidecar compile target, worker spawn,
> gate shells, process-tree kill, and the Tauri installer — all Windows
> behavior, behind the existing interfaces.
>
> The Linux GUI is untouched. No Linux behavior changes in any slice except
> shared refactors that are covered by the existing Linux gates.

---

# How to read this file

**Everything above the first `## ` heading is design record; everything below it is the
machine-parsed slice region.** ompo's parser (`src/parse.ts`, `splitSections`) treats
every `## ` heading as a slice and every line after it as that slice's body — so the
analysis sections (A–G) are deliberately written with `#`/`###` headings and placed
*before* the slices, where the parser discards them. Slice bodies are therefore
self-contained: a worker assigned `g03` never sees sections A–G and does not need them.

Run it with an explicit path (this file is **not** the default `ROADMAP.md`):

```bash
ompo plan --roadmap docs/windows-gui-roadmap.md          # structure + lint, exit 1 when blocked
ompo run --roadmap docs/windows-gui-roadmap.md --dry-run # dependency order, spawns nothing
ompo run --roadmap docs/windows-gui-roadmap.md           # execute (needs a Windows host for g05+)
```

Slice ids (`g00`…`g08`) are stable. Title text may be renamed freely; **ids may never be
renamed once a run starts** (`Depends:` is id-only, and `ompo replan` keys on ids).

**Linux-gated slices (`g00`–`g04`) run on the Linux dev box. Windows-gated slices
(`g05`–`g08`) need a real Windows 10/11 host** with the Windows `omp` terminal client
installed and logged in. Nothing in `g05`+ is asserted from Linux.

---

# A. What already exists (do not rebuild)

Facts from the tree, with the file that proves them:

- Tauri 2 shell, packaging-only: one window (`main`, 1600×1000, hidden until the
  handshake), zero `#[tauri::command]`s, zero data commands
  (`desktop/src-tauri/src/main.rs`, `desktop/src-tauri/tauri.conf.json`).
- Sidecar contract: `bundle.externalBin: ["binaries/ompo"]`, spawned with
  `--no-open --print-url`, cwd = launch dir or `OMPO_PROJECT`, killed on
  close/exit/`Drop` (`main.rs:boot_deck`, `capabilities/default.json` scoped to
  `binaries/ompo` with `sidecar: true`).
- Static verifier, no Rust needed: `scripts/deck-desktop-check.ts`
  (`bun run deck:desktop:check`), locked by `tests/deck-desktop.test.ts`.
- Prereq guard that never installs: `scripts/deck-desktop-run.ts` (Rust missing →
  print `rustup.rs` + point at `bun scripts/deck-open.ts`, exit 1).
- Headless workers are the default: `runOmpWorker` spawns
  `omp -p --mode json --cwd <dir> --no-session --auto-approve` with
  `stdio: ["ignore","pipe","pipe"]`, `detached: true` (`src/worker.ts:382-403`).
  `--tmux` is opt-in (`src/cli.ts:570`, `src/tmux.ts`).
- `omp` is PATH-resolved everywhere (`worker.ts`, `setup.ts`, `doctor.ts`) — never
  vendored. The installer requires it; it does not bundle it.
- `ompo doctor` already probes the full chain: `omp --version`, model
  reachability via real minimal spawn, tmux, git + worktrees, tree cleanliness,
  gate dead-refs, disk (`src/doctor.ts`).
- Single Darwin/win32 branch in the whole CLI: browser opener only
  (`src/cli.ts:1270-1271`). Everything else assumes POSIX.

# B. What is Windows-different (the entire scope)

Exactly five process-boundary concerns. Nothing else is in scope:

1. **Sidecar binary**: `bun build --compile --target=bun-windows-x64` →
   `desktop/src-tauri/binaries/ompo-x86_64-pc-windows-msvc.exe`
   (+ `--windows-hide-console`, icon/title metadata). Tauri resolves the
   `-<target-triple>.exe` suffix from `externalBin` automatically.
2. **Worker spawn**: `spawn("omp", …)` resolves `omp.exe` on PATH on Windows —
   same call, but stdio/kill semantics differ (see 4). Plus `probeOmpModel`'s
   `spawnSync` probe must behave (90 s timeout, ignore-stdin).
3. **Gate shells**: `verify.ts:97`, `services.ts:50`, `unblock.ts:159` hardcode
   `spawn("bash", ["-lc", command])`. No bash on stock Windows → every
   `Verify:` gate fails to spawn. Needs a platform shell selection.
4. **Process-tree kill**: `killWorkerTree` (`worker.ts:166-181`) leads with
   `process.kill(-pid)` (POSIX group kill). On Windows that throws and falls
   through to direct `child.kill()` — orphaning omp's tool grandchildren (bash,
   editors, servers it spawned), which then hold stdio pipes open and wedge
   verdicts exactly the way `verify.ts:136-143` documents. Same gap in
   `killProcessTree` (`server.ts:1072`) for `restart-loop`.
5. **Loop discovery degrades**: `findRunLoops` (`server.ts:221-254`) is a
   `/proc` scan, documented Linux-only; elsewhere it degrades to lock-only.
   Liveness (`pidAlive` → `process.kill(pid, 0)`) still works on Windows, but
   the double-loop guard is weaker and `restart-loop`'s refuse-while-live
   leans on the same signal.

Explicitly **not** scope: second orchestrator, second store, second transport,
new Tauri commands, bundled SPA copy (`bundle.resources` stays empty),
bundled `omp`, `--tmux` on Windows, remote hosting, auth, auto-update,
Windows service/daemon mode, ARM64 Windows (x64 only until proven otherwise).

# C. Platform matrix

| Concern | Linux (existing) | Windows 10/11 x64 (this roadmap) |
|---|---|---|
| Webview | WebKitGTK (software under WSLg) | WebView2 Evergreen (ships with Win 10/11; hardware GL expected) |
| Sidecar | `./ompo` compiled on Linux | `ompo-x86_64-pc-windows-msvc.exe` cross-compiled via Bun |
| Worker | `omp` on PATH (POSIX) | `omp.exe` on PATH (Windows terminal client) |
| Gates | `bash -lc` | Git-Bash if present, else PowerShell (slice `g03` decides) |
| Tree kill | `kill(-pid)` group kill | `taskkill /T` or job object (slice `g02` decides) |
| tmux mode | supported | dead by design (`doctor` reports absent) |
| Installer | none (binary + launcher) | NSIS via `tauri build` (`targets: "all"`) |

macOS: untested before, untested after. This roadmap changes nothing about it.

# D. Gate 0 — prove the premise (g00)

`g00` is the only slice that may say "stop". Its job is to answer, on the real
Windows host with the real Windows `omp` client, before any port code lands:

- Does `ompo.exe --no-open --print-url` (Bun cross-compile, copied over) serve
  the dashboard + deck through a Windows browser, against a run created on
  Windows (git worktrees functional, symlinks OK)?
- Does `omp.exe -p --mode json` spawn headlessly from the sidecar's environment
  (PATH, cwd, stdin-ignore) and stream NDJSON the existing parser accepts?
- Does `ompo doctor` report the honest delta (what passes, what fails, with
  fixes) — i.e. is the failure surface enumerable, not open-ended?

**Stop rule.** If the smoke fails in a way that implicates the architecture
(a second store, a new transport, a Tauri data command), `g00` recommends
stopping and every later slice is dropped. If it fails in one of the five
§B concerns, the roadmap continues — that is what slices `g01`–`g04` are for.
`g01`+ may not start before the `g00` report exists.

# E. Slice map

```
g00 smoke (gate; Windows host, no code)
 └─ g01 sidecar exe + CI matrix (Linux-runnable: compile + verifier)
 └─ g02 tree kill (Linux-runnable: unit + POSIX regression)
 └─ g03 gate shell (Linux-runnable: unit + POSIX regression)
 └─ g04 doctor Windows surface (Linux-runnable: probe-injected unit)
      └─ g05 installer (Windows host: Tauri build)
           └─ g06 acceptance: GUI lifecycle (Windows host, manual)
                └─ g07 acceptance: headless run end-to-end (Windows host, manual)
                     └─ g08 docs + release gate (either host)
```

`g01`–`g04` are independent of each other (all hang off `g00`) and may run in
any order or parallel. `g05` needs `g01` (the exe) at minimum; `g06`–`g08`
are strictly ordered. The two manual acceptance slices never become automated
assertions — a CI runner cannot prove a window opened.

# F. Conventions every slice follows

- **Verify trailers are Linux-runnable gates.** Windows-only behavior is proven
  by `g06`/`g07` manual checklists, recorded in the slice review — never by a
  Linux test pretending to open a webview (the `deck-desktop.test.ts`
  precedent: "nothing here pretends to open a webview").
- **`Files:` is advisory** (repo-relative, space-separated, one line).
- Every slice carries `bunx tsc --noEmit`, `bun test`, `git diff --check` plus
  its own load-bearing gate. `Timeout: 45m`, `Retries: 1`, `Effort:` per slice.
- `Agent:` omitted throughout: all slices inherit `workerModel`
  (`opencode-go/muse-spark-1.3-contributor` → fallbacks), same as the
  web-dashboard roadmap. Add per-slice `Agent:` only with an `agentModels:`
  entry if a slice needs a different model.
- No generated binaries committed (`.gitignore` keeps `ompo`; the Windows exe
  lives under `desktop/src-tauri/binaries/`, gitignored the same way — CI
  builds it, never the repo).
- UX01–UX06 deck work is inherited as-is. No slice re-litigates labels, camera,
  hierarchy, or summaries; Windows acceptance screenshots reuse the same
  2-second scan (`LIVE N · ALERTS N · FOCUS id` + 3 labels).

# G. Risks (kept small on purpose)

- Windows `omp` client flag drift (`-p --mode json --no-session
  --auto-approve`): `g00` smoke catches it on day one, not in `g07`.
- Git worktree symlinks (`linkSharedState`, `src/worktree.ts:61-69`) need
  Developer Mode / SeCreateSymbolicLink — silent best-effort failure today,
  loud verify failure later. `g00` must create a worktree run, not just serve.
- pid reuse on Windows makes `pidAlive` lie; stale-lock reclaim is the backstop
  (`store.ts:136-173`). Accepted, not fixed here.
- WebView2 Evergreen is assumed present; offline machines need the fixed-version
  runtime decision in `g05` (decision, not necessarily implementation).
- ARM64 Windows is out of scope until x64 ships and someone asks with hardware.

---

## [g00] Windows smoke and stop-go report

### Goal

Prove the premise on the real Windows host before any port code lands: the
Bun cross-compiled sidecar serves, the Windows `omp` client spawns headlessly,
and `doctor` enumerates the delta honestly. This slice writes no product code.

### Requirements

On a real Windows 10/11 x64 host with the Windows `omp` terminal client installed
and logged in, and a scratch git repo (never the ompo repo itself):

1. Cross-compile on Linux: `bun build --compile
   --target=bun-windows-x64 --windows-hide-console src/cli.ts --outfile
   /tmp/ompo.exe`. Copy to Windows. No source changes.
2. On Windows: `ompo.exe --no-open --print-url` → single `url=` line, then
   open `<url>/?surface=deck` in Edge/Chrome. Record: dashboard renders, deck
   renders (tier as classified by real D3D11/ANGLE, likely `standard`/`high`),
   `?surface=deck` + deck chunk both 200.
3. On Windows: create a scratch run with a worktree slice
   (`ompo.exe init` + `ompo.exe run` on a 2-slice fixture, or the `serve.ts`
   equivalent by hand). Record: worktree created, symlink state, run completes
   or fails with its real verdict.
4. From the sidecar's environment, spawn the headless probe by hand
   (`omp.exe -p --mode json --no-session --auto-approve --thinking=off
   --no-session "Reply with the single word ok"`) with stdin ignored. Record:
   exit 0, NDJSON parses, no 600 s hang (the `worker.ts:391-393` stdin trap).
5. `ompo.exe doctor` on the scratch project. Record every check
   (omp/models/tmux/git/tree/gates/disk/recovery) with its fix line.

### Stop rule

Write the report to `docs/windows-gui-smoke.md` (new file, this slice's only
artifact besides the report). Verdict is one of: **GO** (continue as written),
**GO WITH CHANGES** (fold remediations into `g01`–`g04`, amend this file
first), or **STOP** (failure implicates the architecture — second store,
new transport, Tauri data command — drop `g01`+). `g00` recommends; the
operator decides. Nothing downstream starts before the report exists.

### Acceptance

The report names the Windows host, omp version, GPU/renderer string, and the
exact commands run, with raw output linked or pasted. At least one failure
mode is recorded honestly (a report with no negatives is bounced).

Effort: med
Timeout: 45m
Retries: 1
Verify: git diff --check
Verify: test -f docs/windows-gui-smoke.md
Files: docs/windows-gui-smoke.md

## [g01] Windows sidecar binary and CI matrix

### Goal

Make the Windows `ompo.exe` sidecar a build-matrix output, staged where Tauri
expects it, with the verifier pinning the contract. No runtime behavior change
on Linux.

### Requirements

1. Add a CI job (`windows-latest`): `bun install --frozen-lockfile`, then
   `bun build --compile --target=bun-windows-x64 --windows-hide-console
   src/cli.ts --outfile desktop/src-tauri/binaries/ompo-x86_64-pc-windows-msvc.exe`
   plus `--windows-icon/title/publisher/version/description` metadata. The exe
   is a CI artifact, never committed (extend `.gitignore` for
   `desktop/src-tauri/binaries/` the way `ompo` is ignored today).
2. Extend `scripts/deck-desktop-check.ts` + `tests/deck-desktop.test.ts`: assert
   `externalBin` still names `binaries/ompo` (Tauri resolves the
   `-x86_64-pc-windows-msvc.exe` suffix per target — no config change), and
   that the binaries dir stays untracked. Keep the check Rust-free.
3. Prove the exe boots headlessly without a window: on CI (or any Windows
   runner), `ompo.exe --no-open --print-url` prints one `url=` line and
   `/api/health` answers `{"ok":true}`. No webview, no Tauri in this slice.

### Acceptance

Linux CI stays green; the new job produces the exe artifact; the desktop check
passes; no Linux runtime file changes behavior (diff is CI + scripts + tests +
gitignore).

Depends: g00
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun scripts/deck-desktop-check.ts
Files: .github/workflows/ci.yml .gitignore scripts/deck-desktop-check.ts tests/deck-desktop.test.ts desktop/src-tauri/tauri.conf.json

## [g02] Windows process-tree kill

### Goal

Kill the worker AND its tool grandchildren on Windows, closing the exact gap
`worker.ts:166-181` documents (group kill unavailable → direct kill orphans →
pipes wedge verdicts). Linux behavior unchanged.

### Requirements

1. In `src/worker.ts`, branch `killWorkerTree` on `process.platform ===
   "win32"`: tree kill first (`taskkill /PID <pid> /T /F` via `spawnSync`,
   timeout-bounded), direct `child.kill()` as fallback. Never throws (existing
   contract). Keep the pid-reuse guard: callers skip reaped children.
2. Same branch in `killProcessTree` (`src/server.ts:1072`) for `restart-loop`:
   refuse-while-live must mean the tree is dead, not just the root.
3. Unit tests with real process trees (Linux-runnable): spawn a shell that
   spawns a grandchild holding a pipe; assert the tree dies and the pipe
   closes under the new path (inject the Windows branch via a platform seam —
   do not `Object.defineProperty(process, 'platform')` globally; pass it).
   Existing POSIX tests keep passing unmodified.
4. Document the fallback chain in the function comments: taskkill → direct
   kill → (Windows acceptance in `g07` proves grandchildren actually die).

### Acceptance

New tests fail pre-fix (orphan survives, pipe stays open) and pass post-fix;
full `bun test` green; no Linux spawn-path behavior change.

Depends: g00
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: src/worker.ts src/server.ts tests/worker.test.ts

## [g03] Windows gate shell selection

### Goal

Route `Verify:` gates, service commands, and unblock probes through a shell
that exists on the host. `bash -lc` stays the Linux path verbatim.

### Requirements

1. One platform seam (new `src/shell.ts` or equivalent, pure + unit-tested):
   `gateShell()` returns `["bash", ["-lc"]]` on POSIX; on win32, Git-Bash
   (`C:\Program Files\Git\bin\bash.exe` when present) else PowerShell
   (`powershell -NoProfile -Command`). Decision recorded in the `g00` report
   takes precedence if it names a better probe order.
2. Rewire the three `bash -lc` call sites through it: `src/verify.ts:97`
   (`runCommand`), `src/services.ts:50` (`exec`), `src/unblock.ts:159`.
   Spawn-error text keeps naming the shell tried (today's `spawn error:`
   observability stays).
3. `doctor.ts` gates check gains a Windows note: when Git-Bash is absent and
   gates contain POSIX-only syntax, say so with the install fix (no new probe
   framework — one conditional sentence).
4. Unit tests: seam returns bash on linux/darwin fixtures, Git-Bash-or-PS on
   win32 fixtures; a gate with `&&` chains runs through the seam on Linux
   exactly as today (regression: existing `verify.test.ts` green unmodified).

### Acceptance

`bash -lc` appears in no spawn call site outside the seam; Linux gates behave
byte-identically; installer docs (`g08`) can promise "Git-Bash recommended,
PowerShell fallback" with the failure mode named.

Depends: g00
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: src/shell.ts src/verify.ts src/services.ts src/unblock.ts src/doctor.ts tests/verify.test.ts

## [g04] Doctor Windows surface and installer prereqs

### Goal

Make `ompo doctor` the Windows prereq screen: every check reports the honest
Windows delta with a fix line, so the installer (`g05`) and docs (`g08`) quote
it instead of inventing their own list.

### Requirements

1. Through the existing probe seams (no new framework): `tmux` reports absent
   with "headless only on Windows" (today's text already says install tmux —
   make it platform-aware); `df -k` disk check degrades gracefully when absent
   (null → "unknown", never FAIL); `omp --version` + model probe unchanged
   (Windows `omp.exe` answers the same flags — `g00` proves it); git +
   worktree checks unchanged (failure text already actionable).
2. Add one `windows` summary line when `process.platform === "win32"`: shell
   selection (`g03` seam result), WebView2 presence note (best-effort registry/
   path probe — absent reads "unknown, installer handles it", never FAIL),
   `omp.exe` resolved path. Pure, probe-injected, unit-tested in
   `tests/doctor.test.ts` alongside the existing fake-probe cases.
3. The full expected Windows `doctor` output becomes the installer prereq list
   (g05 quotes it; g08 prints it). No second prereq list may exist.

### Acceptance

`tests/doctor.test.ts` gains win32-fixture cases (all-green with fake probes);
Linux `doctor` output byte-identical; `g00`'s recorded delta matches what the
new checks report.

Depends: g00
Effort: lo
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: src/doctor.ts tests/doctor.test.ts

## [g05] Windows installer (Tauri build)

### Goal

Produce the installable: NSIS installer from `tauri build` on a Windows host,
bundling the `g01` sidecar exe, opening the deck against a Windows project dir.

### Requirements

1. On the Windows host: install Rust (rustup) + WebView2 SDK + Tauri CLI
   prereqs per `tauri` docs; `bun run deck:desktop:build` produces the NSIS
   `.exe` (and optionally MSI). `targets: "all"` already set — no config
   change expected, record any that proves necessary.
2. `OMPO_PROJECT` (or installer-chosen cwd) points at a Windows path with a
   git repo + ROADMAP.md; sidecar spawns, handshake lands within 5 s, deck
   window shows at 1600×1000 against the Windows project (not WSL).
3. Boot-failure paths proven by fault injection: sidecar missing → small error
   window with stderr tail + reproduce command; sidecar killed mid-session →
   "ompo stopped" + relaunch respawns (the `main.rs` contract, now observed
   on Windows instead of asserted statically).
4. Decide the WebView2 story and record it: Evergreen assumption vs
   fixed-version bootstrapper for offline machines (decision required,
   implementation only if Evergreen proves insufficient).
5. No source changes expected in this slice. If the build needs any
   (`tauri.conf.json`, capabilities, `main.rs`), they land here with
   `deck-desktop-check` extended to pin them — and Linux `deck:desktop:check`
   still passes.

### Acceptance

Installer installs, launches, shows the deck, uninstalls cleanly; fault
injection observed (not asserted); WebView2 decision recorded; any config
change is pinned by the static check.

Depends: g01
Effort: med
Timeout: 45m
Retries: 1
Verify: bun scripts/deck-desktop-check.ts
Verify: git diff --check
Files: desktop/src-tauri/tauri.conf.json desktop/src-tauri/capabilities/default.json desktop/src-tauri/src/main.rs scripts/deck-desktop-check.ts tests/deck-desktop.test.ts

## [g06] Acceptance — GUI lifecycle on Windows (manual)

### Goal

Prove the installed app behaves: launch, deck URL, close-cleanup, recovery —
on the real Windows host, by a human, recorded once. This slice is a checklist
with evidence, not automated tests.

### Requirements

Run the installed app against a scratch Windows project and record (version
numbers, screenshots or it didn't happen):

1. Launch → deck window at `?surface=deck` within 5 s of sidecar spawn; tier
   as classified by the real renderer string (expect `standard`/`high` on
   hardware GL — record the string).
2. The UX01–UX04 scan holds on Windows: `LIVE N · ALERTS N · FOCUS id` row,
   3 projected labels, station line, alert head. Same 2-second test as Linux.
3. Close window → sidecar dead (`tasklist` shows no `ompo.exe` for the run);
   app exit → same; kill sidecar mid-session → "ompo stopped" window, relaunch
   respawns + reloads.
4. `T` tier cycle incl. `flat`, `M` reduced motion, `H` help modal + Esc,
   dock open on `1`, `0` reframe — keys behave as on Linux.
5. Second launch while the first runs: harmless (read-only server +
   lock-guarded control — record the observed behavior, not the theory).

### Acceptance

Checklist complete with evidence linked (screenshots + renderer string +
`tasklist` outputs); any deviation filed as a follow-up slice or accepted
risk in the slice review — never re-pinned silently. No code expected; if
code results, it gets its own slice.

Depends: g05
Effort: med
Timeout: 45m
Retries: 1
Verify: git diff --check
Verify: test -f captures/windows-gui/g06-lifecycle.md
Files: captures/windows-gui/g06-lifecycle.md

## [g07] Acceptance — headless run end-to-end on Windows (manual)

### Goal

Prove the product, not the packaging: a real `ompo run` driven by headless
Windows `omp` workers, watched from the installed deck, killed and recovered
through it. The deliverable is the run, not the installer.

### Requirements

On the same Windows host, scratch git repo, Windows `omp.exe` on PATH and
logged in:

1. `ompo.exe doctor` green (or amber-with-reason per `g04`); `ompo.exe init`
   + a 2–3 slice fixture with `Verify:` gates that run on Windows (no
   POSIX-only syntax — the `g03` docs say what that means).
2. `ompo.exe run` headlessly (no terminal watching workers): slices claim,
   `omp -p --mode json` workers stream, verdicts land, run completes with its
   real exit code. Record turns/tools/tokens per slice.
3. Watch from the installed deck: live count moves, labels follow focus,
   alerts render with beacons, history scrub + RETURN TO LIVE works, dock
   Inspector shows Output/Diff/Verify for the Windows run.
4. Wedged-loop recovery through the deck: `restart-loop` with reason →
   `taskkill /T` tree actually dies (`tasklist` before/after — the `g02`
   proof, now on the real target), fresh loop spawns, `control_applied` on
   the event log.
5. `ompo.exe run --tmux` fails with the documented message (dead by design,
   not a bug report).

### Acceptance

A completed Windows run with worker evidence (reports, verdicts, event log
tail) + deck screenshots + `tasklist` kill proof + the tmux refusal. Verdict
Strong/Complementary/Narrow does not apply here — this gate is go/no-go for
the Windows product: runs work headlessly or they don't. Failures become
slices, not silence.

Depends: g06
Effort: hi
Timeout: 45m
Retries: 1
Verify: git diff --check
Verify: test -f captures/windows-gui/g07-headless-run.md
Files: captures/windows-gui/g07-headless-run.md

## [g08] Windows docs and release gate

### Goal

Close the sprint: installer prereqs, operator workflow, and the gate that
keeps Windows green. Smallest slice that can say "shipped".

### Requirements

1. `desktop/README.md` gains the Windows install path: prereqs (Windows omp
   client + login, Git with Bash, WebView2 story from `g05`, `ompo setup`,
   `ompo doctor` — quoted from `g04`, no second list), install/launch/update/
   uninstall, `OMPO_PROJECT` for the served dir, troubleshooting (firewall,
   stale lock reclaim, POSIX-only gates, tmux refusal, ARM64 out of scope).
2. Release gate: Linux `bunx tsc --noEmit` + `bun test` + `git diff --check`
   + `bun scripts/deck-desktop-check.ts` all green; Windows CI job (`g01`)
   green with the exe artifact; `g06` + `g07` evidence files present.
3. Record the standing deltas in the architecture note (or its Windows
   section): `/proc` scan Linux-only (lock-only on Windows), pid-reuse caveat
   on NTFS, `tmux` unsupported, gate-shell selection, WebView2 decision.
4. Explicit non-goals restated: no ARM64, no auto-update, no service mode, no
   bundled omp, no macOS change.

### Acceptance

A Windows operator with no repo context can install, serve a project, run it
headlessly, watch it in the deck, kill and recover it, using only the README
plus `doctor`. The gate list above is green at merge.

Depends: g07
Effort: lo
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun scripts/deck-desktop-check.ts
Files: desktop/README.md docs/deck-architecture.md package.json
