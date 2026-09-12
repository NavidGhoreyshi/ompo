# Contributing to ompo

Thanks for looking. One constraint is worth knowing before anything else:
**ompo drives `omp`; it does not fork it.** Slices run out-of-core through
`omp -p` workers, so a change that needs core edits belongs upstream in
`omp` instead.

## Setup

```bash
bun install
bun test              # unit/integration, mocked workers — no model calls
bunx tsc --noEmit     # the type gate
bun run test:e2e      # Playwright browser suite (installs Chromium on first run)
bun run build         # web bundle + compiled ./ompo binary
```

`ompo doctor` pre-flights a real machine (models, git, tmux, disk, gates).

## Before you open a PR

- `bunx tsc --noEmit && bun test` green, `git diff --check` clean.
- Tests assert **behavior** — statuses, verdict tails, files on disk, gate
  re-runs — not source text, incidental defaults, or CSS rules. A test that
  pins wording should be deleted, not re-pinned. See `docs/development-prd.md`
  §8 for what earns a test.
- One concern per commit; the body explains *why*, not what the diff says.
- `web/src` changes: regenerate the embedded bundle (`bun run web:build`) —
  the dashboard and the compiled binary serve that file, not `web/`.
- TUI layout math changes: regenerate captures (`bun scripts/gen-captures.ts`).

## Where to look first

| Path | What it holds |
|---|---|
| `docs/development-prd.md` | stack, dev lifecycle, testing strategy, coding standards, accepted trade-offs |
| `docs/web-dashboard-architecture.md` | browser API contract (the DTOs and their invariants) |
| `docs/web-dashboard-implementation.md` | what the dashboard actually does, and which tests pin it |
| `README.md` | the operator manual — user-facing behavior |
| `HARP-1.md` | the work-order template a change is usually written against |

## Reporting bugs and security issues

Bugs: open an issue with the run id, `ompo doctor` output, and the smallest
roadmap that reproduces it. Vulnerabilities: **not** in a public issue — see
`SECURITY.md`.
