# Cockpit Daily-Driver Implementation Plan

> **For agentic workers:** Execute tasks in order with test-driven development. This plan started as Medium and was escalated to Large when the implementation exceeded 10 files. Do not commit unless the user explicitly asks.

**Goal:** Ship Cockpit in macOS arm64 releases, install/update it through the checksum-gated installer, and make interactive bare `cw` prefer it with a reliable TUI fallback.

**Architecture:** A testable CLI launcher decides whether LaunchServices can open the installed app. Electron accepts the current repository through argv and owns single-instance workspace switching. The existing release and installer path gains one checksummed zip asset; `cw update` inherits the behavior by continuing to execute the verified installer.

**Tech Stack:** Bun 1.3.14, TypeScript, Electron 44, electron-builder 26, POSIX shell, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-18-cockpit-daily-driver-design.md`

## Global Constraints

- Cockpit is produced and installed only for `darwin-arm64`.
- Default destination: `~/Applications/crossweave Cockpit.app`.
- Asset names: `cockpit-darwin-arm64.zip` and `cockpit-darwin-arm64.dmg`.
- Verify every downloaded artifact against `checksums.txt` before mutating an install.
- Never use a shell-interpolated launch command.
- Bare non-TTY behavior and explicit `cw tui` behavior must not change.
- No native dependency additions, tags, pushes, releases, or writes to the developer's real Applications directory.

---

### Task 1: Testable CLI Cockpit launcher

**Files:**
- Create: `src/cli/cockpit-launcher.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/entry-mode.ts`
- Test: `tests/cli/cockpit-launcher.test.ts`
- Test: `tests/cli/entry-mode.test.ts`

**Interfaces:**
- `cockpitAppPath(homeDir: string): string`
- `tryOpenCockpit(deps?: CockpitLaunchDeps): Promise<boolean>`
- `CockpitLaunchDeps` injects `platform`, `arch`, `homeDir`, `cwd`, `exists`, and an argv-based `launch` function.

- [x] Write tests proving unsupported platforms, missing app, successful exact `open -n -a ... --args --project-root=...`, non-zero exit, and thrown launch all return the required boolean.
- [x] Run `bun test tests/cli/cockpit-launcher.test.ts tests/cli/entry-mode.test.ts` and verify RED because the launcher module does not exist.
- [x] Implement the minimal launcher with no shell string.
- [x] Route only interactive bare `cw` through it; successful Cockpit launch exits without constructing the TUI, all other interactive bare calls run `tuiCommand`.
- [x] Run the focused tests and `bun run typecheck` until green.

### Task 2: Cockpit argv and single-instance workspace switching

**Files:**
- Create: `apps/cockpit/electron/project-root.ts`
- Modify: `apps/cockpit/electron/main.ts`
- Test: `apps/cockpit/tests/project-root.test.ts`

**Interfaces:**
- `projectRootFromArgv(argv: readonly string[]): string | undefined`
- `resolveLaunchProjectRoot(argv: readonly string[], envRoot?: string): string | undefined`

- [x] Write tests for `--project-root=/path`, paths containing spaces, malformed/empty values, no value, and argv-over-env precedence.
- [x] Run the focused test and verify RED because the module does not exist.
- [x] Implement the parser.
- [x] Acquire Electron's single-instance lock before `whenReady`; quit the forwarding process when the lock is unavailable.
- [x] On first launch, pass the resolved root to `workspace.ensure`.
- [x] On `second-instance`, parse forwarded argv, switch via `workspace.ensure`, recreate the BrowserWindow, and focus it. Ignore a second invocation with no project-root rather than reopening the folder picker.
- [x] Run Cockpit tests and build until green.

### Task 3: Release Cockpit assets

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `apps/cockpit/README.md`
- Modify: `README.md`

**Deliverable:** A `cockpit` job on `macos-14` installs root and app dependencies, runs Electron's install script, packages arm64, renames the zip/dmg to the fixed asset contract, and uploads them. The release job downloads the new artifact, includes both files in checksums, and attaches both files.

- [x] Add the Cockpit packaging job and make `release` depend on both binary and Cockpit builds.
- [x] Keep artifact paths space-free after the rename.
- [x] Document release installation, fallback behavior, and the unsigned/not-notarized limitation.
- [x] Parse/review the workflow and run Cockpit build before moving on.

### Task 4: Checksum-gated Cockpit installation

**Files:**
- Modify: `install.sh`
- Create: `tests/packaging/install-cockpit.test.ts`
- Modify: `docs/superpowers/specs/2026-08-14-m7-smoke-test-checklist.md`

**Test seams:**
- `CW_INSTALL_BASE_URL` overrides release resolution for local deterministic tests.
- `CW_COCKPIT_INSTALL_DIR` overrides `~/Applications`.
- A fake `uname` on `PATH` controls OS/architecture without changing production detection.

- [x] Build a local fake release server and zip fixture in the test; write failing tests for arm64 install/update, Linux omission, and bad Cockpit checksum leaving existing files unchanged.
- [x] Run the focused test and verify RED against the existing installer.
- [x] Update `install.sh` to download the Cockpit zip only for `darwin-arm64`, verify with `verify_one`, extract and validate the exact app bundle, stage the previous managed app, and install the new bundle.
- [x] Preserve existing CLI/daemon behavior and ensure every verification happens before the first install mutation.
- [x] Run `sh -n install.sh`, the focused test, and update the manual smoke checklist.

### Task 5: Full verification and documentation consistency

**Files:**
- Modify if required by verified behavior: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`
- Modify: `docs/superpowers/plans/2026-09-18-cockpit-daily-driver.md` (mark completed steps only after evidence exists)

- [x] Run `bun run typecheck`.
- [x] Run `bun test` and record the total.
- [x] Run `bun run build`.
- [x] Run `bun test` and `bun run build` in `apps/cockpit`.
- [x] Run Electron binary installation if needed, then `bun run dist:mac` and `bun run package:smoke` outside restricted sandbox if the environment blocks packaging/runtime operations.
- [x] Inspect `git diff --check`, `git status`, and the final diff; run the `review` skill and fix every finding attributable to this change.
