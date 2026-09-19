# Cockpit daily-driver distribution — Design Spec

**Date:** 2026-09-18
**Status:** Approved
**Scope:** Publish the macOS arm64 Cockpit with every release, install it through the existing checksum-gated installer, and make bare `cw` prefer it without weakening the TUI fallback.

## 1. Goal

A macOS arm64 user who installs crossweave with the documented `curl | sh`
command gets the CLI, daemon, and Cockpit together. In an interactive terminal,
bare `cw` opens Cockpit for the current repository. `cw tui` remains the explicit,
cross-platform terminal dashboard and the automatic fallback when Cockpit is not
available.

## 2. Release asset contract

The release workflow keeps the existing `cw-<target>` and `cwd-<target>` assets and
adds exactly two macOS arm64 Cockpit assets:

- `cockpit-darwin-arm64.zip` — machine-installable app bundle;
- `cockpit-darwin-arm64.dmg` — human-installable disk image.

Both assets are generated on `macos-14`, uploaded to the release job, included in
`checksums.txt`, and attached to the GitHub Release. Cockpit and core versions remain
locked by `apps/cockpit/tests/version.test.ts`.

The package remains macOS arm64 only. No Cockpit artifact is produced for macOS x64
or Linux, and those platforms continue to use the TUI.

## 3. Installer behavior

On every supported platform, `install.sh` continues to download and verify the CLI
and daemon before installing them. On `darwin-arm64` it additionally downloads
`cockpit-darwin-arm64.zip`, verifies its checksum from the same release manifest,
and extracts it in the temporary staging directory.

Only after every required artifact verifies and the app bundle shape is valid does
the script change the installed files. The default app destination is:

`~/Applications/crossweave Cockpit.app`

`CW_COCKPIT_INSTALL_DIR` overrides the containing directory for deterministic smoke
tests. Updating uses the same verified `install.sh`, so `cw update` replaces the
Cockpit together with `cw` and `cwd`; there is no second updater.

If a previous app exists at the exact managed destination, the installer moves it
into the already-private temporary directory before moving the staged app into
place. It never removes or overwrites any other application path. Verification or
extraction failure leaves the current CLI, daemon, and app untouched.

## 4. Bare CLI routing

`shouldOpenApp` continues to define whether a bare invocation is interactive:
exactly two argv entries and stdout attached to a TTY. Non-interactive invocations
still print help byte-for-byte, and explicit flags/subcommands are never rerouted.

For an interactive bare invocation:

1. On macOS arm64, look for the executable inside
   `~/Applications/crossweave Cockpit.app`.
2. If present, invoke LaunchServices with argv, never a shell string:
   `open -n -a <app-path> --args --project-root=<cwd>`.
3. Exit the CLI when `open` succeeds.
4. Run the TUI when the app is absent, the platform is unsupported, or `open`
   exits non-zero or throws.

`cw tui` always starts the TUI. A failed GUI preference must never make crossweave
unusable.

The detection and argv construction live in a small module with injected filesystem,
platform, cwd, and process-launch dependencies so tests never open a real GUI.

## 5. Cockpit process and workspace switching

Cockpit accepts `--project-root=<absolute-path>` in addition to the existing
`COCKPIT_PROJECT_ROOT` development seam. The argv value wins when both exist.

The app takes Electron's single-instance lock before creating windows. A later bare
`cw` launch starts a short-lived second process; Electron forwards its argv to the
existing instance. The existing instance then:

1. calls `workspace.ensure` with the forwarded project root;
2. recreates the BrowserWindow so no pane, subscription, or per-session React key
   from the previous workspace survives;
3. restores and focuses the window.

A first launch uses the same project-root parser. Folder picking and the saved-root
fallback remain unchanged when neither argv nor the environment provides a root.

## 6. Failure handling and security

- Release downloads remain HTTPS GitHub Release assets.
- SHA-256 verification is mandatory before any install mutation.
- Cockpit launch uses an argv list, not an interpolated shell command.
- A missing or broken Cockpit degrades to the existing TUI.
- The app is currently unsigned/not notarized. Checksums establish release-asset
  integrity but do not replace Apple signing or notarization; this remains an
  explicit limitation.
- No task pushes a tag, publishes a release, installs into the developer's real
  `~/Applications`, or touches production credentials.

## 7. Testing and verification

Automated tests cover:

- platform/architecture/app-presence routing;
- exact `open` argv and project-root forwarding;
- launch failure falling back to TUI;
- Cockpit project-root argv parsing and precedence;
- installer behavior against a local fake release: arm64 app install/update,
  non-arm64 omission, and checksum failure before mutation.

Verification also includes root typecheck/tests/build, Cockpit tests/build, shell
syntax checking, a local Electron package, and `package:smoke`. The GitHub release
workflow is reviewed and syntax-checked locally; publishing remains a separate,
human-triggered action.
