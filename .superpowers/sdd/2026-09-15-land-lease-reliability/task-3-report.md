# Task 3 Report: evidence-gated `land all`

## Outcome

Wired `converge.status` to classify active sessions as `ready`, `unknown`, or `blocked`, with `conflictFree` retained as an alias of `ready`. CLI and TUI land-all flows now re-fetch status after every successful land so they never continue from evidence computed against a moved base.

## Changes

- `converge.status` now:
  - resolves the current base `HEAD`
  - detects trust for the current `converge.testCommand` hash
  - delegates evidence decisions to `classifyLandability`
  - returns `ready`, `unknown`, `blocked`, and `conflictFree: ready`
  - includes `baseHead` in `fullIntegration`
- `cw land all` now:
  - re-fetches `converge.status` before every land
  - lands `ready` sessions first
  - without `--force`, stops when evidence is incomplete and prints the first unknown reason on stderr
  - with `--force`, permits `unknown` sessions with an explicit incomplete-evidence warning
  - never selects `blocked` sessions
  - prints one `stopped at ...` line and sets exit code 1 on a land failure without rethrowing through `fail()`
- TUI `land all` now uses `landAllInOrder(fetchReady, land)` and re-fetches readiness after every successful land.
- Convergence status output now shows ready, unknown, and blocked classifications.
- Updated older RPC-level land-all tests to seed fresh evidence instead of treating absent trials as safe.

## TDD Evidence

The initial focused run failed for the intended missing behavior:

```text
Export named 'chooseNextLand' not found
TypeError: fetchReady function is not iterable
Expected ready: [], received undefined
```

A separate red test confirmed `fullIntegration.baseHead` was absent before that response field was restored.

## Verification

- `bun test tests/daemon/methods-converge.test.ts tests/cli/land.test.ts tests/cli/tui-actions.test.ts tests/convergence/`: 75 passed, 0 failed
- `bun run typecheck`: passed
- `bun test`: 651 passed, 0 failed, 1485 assertions across 83 files
- `git diff --check`: passed

## Self-review

- Confirmed candidate selection always prefers `ready`, permits `unknown` only under `--force`, and has no path that selects `blocked`.
- Confirmed both CLI and TUI fetch a new status after each successful land.
- Confirmed CLI land failures return from the command after one output line instead of reaching the outer error printer.
- Confirmed `printLandResult` still preserves `tested: clean` versus `tested: unverified`.
- Confirmed no dependencies or out-of-scope Task 4–7 work were added.

## Concerns

None.

## Review Fix: always report an empty ready set

### What changed

Removed the `landedAny` guard from the CLI land-all loop. Whenever a re-fetched status has no eligible candidate, `cw land all` now prints `nothing to land`, including after one or more ready sessions were landed.

### Covering tests

- `tests/cli/land.test.ts`
- `tests/convergence/land.test.ts`

### Command

```text
bun test tests/cli/land.test.ts tests/convergence/land.test.ts
```

### Output

```text
31 pass
0 fail
84 expect() calls
Ran 31 tests across 2 files. [10.79s]
```
