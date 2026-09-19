# Cockpit daily-driver distribution — known limitations

**Date:** 2026-09-18

- Cockpit remains macOS arm64 only. macOS x64 and Linux installs receive `cw` and
  `cwd`; bare `cw` uses the TUI there.
- The app is not Apple-notarized. SHA-256 verification protects the release asset
  downloaded by `install.sh`, but macOS may still require **Privacy & Security →
  Open Anyway** on first launch.
- CLI fallback covers an absent app and an immediate non-zero/failed `open`
  invocation. Once LaunchServices accepts the app, a later Electron crash cannot
  return control to the already-exited CLI; `cw tui` remains the explicit recovery
  path.
- `~/Applications/crossweave Cockpit.app` is the only path bare `cw` discovers.
  `CW_COCKPIT_INSTALL_DIR` exists for isolated installer tests, not as a persistent
  user-facing relocation setting.
- The installer deliberately skips Cockpit when an older release's
  `checksums.txt` has no `cockpit-darwin-arm64.zip` entry. This keeps the raw-main
  installer compatible with published `v0.3.0`, whose release predates the app
  asset.
