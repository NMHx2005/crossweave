# CI root-test stability — design

## Problem

The latest CI run (`38111732784`, 2026-10-11) failed in the root `bun test` step for two separate reasons. Four real-shell tests timed out in their 25–30 second `until` loops, while six Cockpit view tests could not resolve `preact/jsx-dev-runtime`. The two earlier failures (`37848936997` and `37851461440`, 2026-10-08) each had the same missing-Preact error; they did not show the daemon timeouts. The handoff had therefore captured only one failure from the latest run.

## Goal and boundaries

Make the CI gates reflect their existing split: Linux runs the engine and website suites, and the macOS job installs and runs Cockpit's dependencies and tests. Bound the Linux test concurrency to avoid starving PTY-backed daemon integration tests. Preserve all behavioral assertions; do not change checkpoint production or status inference without evidence of a product defect.

## Design

The latest CI log records these elapsed times: the checkpoint integration timed out at 25.1 seconds; three auto-check integration cases timed out at 30.1 seconds each; six view tests failed during module loading. The two 2026-10-08 logs each show one Cockpit test failing during module loading, before any timeout. The Linux job runs bare `bun test`, which discovers Cockpit tests although it does not install Cockpit's macOS-only dependencies; a separate macOS job already installs those dependencies and runs the app suite.

With Bun 1.3.14, the checkpoint integration passed three consecutive local serial runs (6.8–7.3 seconds each), and all three auto-check integration cases passed serially (13.9, 7.9 and 8.1 seconds). The same checkpoint test fails inside the restricted sandbox because the sandbox denies port allocation, then passes outside it. However, the first proposed CI-only fix did not solve the remote failure: run `38200756671` still had the same four PTY-backed timeouts after setting concurrency to 1, and six Cockpit tests still failed to load Preact. A comparison run against unchanged `main` commit `122d43c` (`38111732784`) had the same four timeouts and six Preact failures. This confirms the failure predates the branch, but does not establish whether the Linux PTY behavior is a runner limitation or a product defect. The second cause is clear: Bun treats positional test arguments as path-substring filters, so `tests website/tests` did not restrict discovery.

The next diagnostic pass records final session activity, detected agent, checkpoints and `ps` ancestry when those PTY tests time out. Correct test discovery with `--path-ignore-patterns` for Cockpit, and keep all behavioral assertions. Do not exclude the PTY cases or move them to another runner unless diagnostics demonstrate an environment-specific constraint; if Linux product behavior is wrong, fix it with a regression test.

Run `38231615436` confirmed the agent process is present beneath the session shell, detected as `claude`, while activity remains `working` and the only checkpoint is `start`. The next run adds the process descendants so we can tell whether the fake CLI reached its final prompt or is still inside its busy loop. That run also exposed one unrelated `ENOENT` during `cp` of the cached Git template; local repetition of the checkpoint RPC suite passes, so keep this as a separate fixture investigation rather than conflating it with the PTY state.

The cause was the test fixture's use of `printf '\\x1b…'`. Linux's `/bin/sh` is `dash`, whose `printf` prints those bytes literally (`5c 78 31 62`); macOS's shell accepted the extension. As a result, the fake agent's clear-screen sequence was not ANSI, and the visible “esc to interrupt” line never disappeared. `dash printf '\\033…'` emits the expected ESC byte (`1b`), so both PTY fixtures now use the POSIX octal escape. This fixes the test fixture portability without changing product status inference or weakening the assertions. The diagnostic run `38232700603` independently showed the fake CLI already in `sleep 60` after the final prompt, which confirms the script had finished its work and supports this explanation. The isolated fixture-copy `ENOENT` did not recur in that run.

## Acceptance

- The test still proves a `start`/before snapshot and a `turn`/after snapshot around a recognised agent edit, and still proves ordinary shell output does not create automatic checkpoints.
- The focused checkpoint and auto-check tests pass repeatedly with Bun 1.3.14 and concurrency 1.
- The Linux workflow explicitly excludes the Cockpit subtree and runs the engine/site suite with concurrency 1; the Cockpit suite stays in its macOS job.
- The four real-shell automatic-checkpoint/auto-check cases either pass on Linux or have a diagnosed, documented platform boundary while remaining covered by CI on a runner that supports their contract.
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
