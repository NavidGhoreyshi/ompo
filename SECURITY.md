# Security policy

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Use GitHub's private
advisory flow: *Security → Report a vulnerability* on this repository.

Include the version (`ompo --version`), the platform, and a minimal
reproduction. Acknowledgement usually lands within a few days. There is no
bug bounty.

## Scope notes

- The dashboard binds `127.0.0.1` with no auth by default — the same trust
  model as the TUI. `--host 0.0.0.0` exposes it deliberately and prints a
  no-auth warning; don't do that on an untrusted network.
- ompo's own network surface is the loopback dashboard. Model traffic belongs
  to `omp`; ompo has no telemetry.
- Workers run with your user's privileges and edit your repository — treat a
  roadmap like code you are about to run.
- The secret scanner (`src/secrets.ts`) is a safety net over the merge path,
  not a guarantee: a clean scan does not mean a repository holds no secrets.
