# CI root-test stability — design

## Problem

The latest CI run (`38111732784`, 2026-10-11) failed in the root `bun test` step for two separate reasons. Four real-shell tests timed out in their 25–30 second `until` loops, while six Cockpit view tests could not resolve `preact/jsx-dev-runtime`. The two earlier failures (`37848936997` and `37851461440`, 2026-10-08) each had the same missing-Preact error; they did not show the daemon timeouts. The handoff had therefore captured only one failure from the latest run.

## Goal and boundaries

Make the CI gates reflect their existing split: Linux runs the engine and website suites, and the macOS job installs and runs Cockpit's dependencies and tests. Bound the Linux test concurrency to avoid starving PTY-backed daemon integration tests. Preserve all behavioral assertions; do not change checkpoint production or status inference without evidence of a product defect.

## Design

The latest CI log records these elapsed times: the checkpoint integration timed out at 25.1 seconds; three auto-check integration cases timed out at 30.1 seconds each; six view tests failed during module loading. The two 2026-10-08 logs each show one Cockpit test failing during module loading, before any timeout. The Linux job runs bare `bun test`, which discovers Cockpit tests although it does not install Cockpit's macOS-only dependencies; a separate macOS job already installs those dependencies and runs the app suite. The bare command also uses Bun's default test concurrency.

With Bun 1.3.14, the checkpoint integration passed three consecutive local serial runs (6.8–7.3 seconds each), and all three auto-check integration cases passed serially (13.9, 7.9 and 8.1 seconds). The same checkpoint test fails inside the restricted sandbox because the sandbox denies port allocation, then passes outside it; that is an environment limitation, not a product regression. The evidence supports a CI-only fix: scope the Linux command to `tests` and `website/tests`, and run it with `--max-concurrency=1`. Keep the macOS Cockpit test gate unchanged. Do not expand test timeouts or weaken assertions.

## Acceptance

- The test still proves a `start`/before snapshot and a `turn`/after snapshot around a recognised agent edit, and still proves ordinary shell output does not create automatic checkpoints.
- The focused checkpoint and auto-check tests pass repeatedly with Bun 1.3.14 and concurrency 1.
- The Linux workflow runs only `tests` and `website/tests` with concurrency 1; the Cockpit suite stays in its macOS job.
- `bun test --max-concurrency=1` and `bun run typecheck` pass locally.
- A CI run on the resulting commit passes the root test job; prior 2026-10-08 runs have been classified as same or unrelated.
- Any remaining environmental limitation is recorded in a known-limitations file and the digest.

## Relevant files

- `tests/daemon/methods-checkpoint-auto.test.ts` — real-shell integration contract and timing loop.
- `src/daemon/checkpoint-trigger.ts` — automatic checkpoint state transitions; change only if evidence identifies a behavior bug or a seam is needed.
- `tests/daemon/checkpoint-trigger.test.ts` — deterministic unit contract for the transition seam.
- `.github/workflows/ci.yml` — runner version and gate; adjust only if the runner setup itself is implicated.
- `docs/HANDOFF-2026-10-11.md` — historical diagnostic record; refresh or supersede after resolution.

## Diagnosis decision

Use the CI job boundary and concurrency settings as the smallest evidence-backed fix. Leave production behavior and integration-test timing bounds untouched. A remote green run is still required before calling the CI gate complete.
