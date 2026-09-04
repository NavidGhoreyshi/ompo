# Roadmap — <project>

> One `## ` section per slice. Ids in brackets are stable — rename titles
> freely, never rename ids after a run starts. Keep slices small enough that
> one worker finishes in one session.

## [01-scaffold] Scaffold

Create the project skeleton (dirs, package manifest, hello-world entry).

Verify: bun test
Files: src/index.ts
Retries: 1

## [02-feature] First feature

Implement the first vertical slice.

Depends: 01-scaffold
Agent: task
Effort: med
Verify: bun test
Files: src/index.ts
Retries: 1

## [03-harden] Harden (example: skipped until needed)

Skip: true
