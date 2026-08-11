# `cw config trust` gate for `converge.testCommand`

Closes the security decision recorded in
`docs/superpowers/specs/2026-08-12-m4-known-limitations.md`: `converge.testCommand`
is repo-controlled (`crossweave.config.json` is committed) and currently
auto-executes with no trust check. This adds an explicit trust gate, keyed to the
exact command string, that must be granted per workspace before the daemon will
ever run it.

## Design

- A workspace trusts a specific `converge.testCommand` **string**, not "converge
  in general." Any edit to the string (a hostile clone changing it, or a
  legitimate config change) requires re-trusting — trust is keyed by
  `sha256(testCommand)`, not a boolean.
- New table `config_trust (workspace_id PK, test_command_hash, trusted_at)` —
  schema v7.
- `cw config trust` reads the current `crossweave.config.json`, hashes
  `converge.testCommand`, and upserts the trust row. `cw config status` reports
  whether the current command is trusted. `cw config untrust` clears it.
- **Enforcement differs by call site, deliberately:**
  - `cw land` (`landSession`): untrusted → **throws** `LAND_TESTCOMMAND_UNTRUSTED`
    and refuses to land. This is the path the known-limitations doc flagged as
    "arguably worse" (gates an irreversible, already-`--yes`-confirmed merge) —
    it must fail closed, not silently skip the test.
  - `ConvergenceScheduler` (background tick): untrusted → **skips** the test run
    and records the trial as `unverified` (same as today's "no testCommand set"
    path), with a one-line stderr warning. A 5-minute background poller cannot
    prompt or block; failing the whole tick would be worse than just not running
    an untrusted command.
- Both sites share one `isTestCommandTrusted()` helper (`src/convergence/trust.ts`)
  so the hash/compare logic isn't duplicated.

## Files

- `src/db/schema.ts` — migration adding `config_trust`, `SCHEMA_VERSION` → 7.
- `src/db/repositories/config-trust.ts` — new `ConfigTrustRepo` (get/upsert/clear).
- `src/convergence/trust.ts` — new `hashTestCommand`, `isTestCommandTrusted`.
- `src/convergence/land.ts` — `LandDeps.configTrust`, enforce before spawning.
- `src/daemon/convergence-scheduler.ts` — constructor takes `ConfigTrustRepo`,
  enforce in `maybeRunFullIntegration`.
- `src/daemon/methods.ts` — wire `ConfigTrustRepo`, add `config.trust` /
  `config.status` / `config.untrust` RPCs, pass `configTrust` into
  `ConvergenceScheduler` and `landSession`.
- `src/cli/commands/config.ts` — new `cw config trust|status|untrust`.
- `src/cli/index.ts` — register `config` command.
- Tests: `tests/db/repositories/config-trust.test.ts`,
  `tests/convergence/trust.test.ts`, plus trust-gate cases added to the existing
  `tests/convergence/land.test.ts` and `tests/daemon/convergence-scheduler.test.ts`.

## Out of scope

- Trusting anything other than `converge.testCommand` (`converge.mergeStrategy`
  etc. carry no execution risk).
- A TUI/interactive prompt — CLI-only, matching the rest of M4.
