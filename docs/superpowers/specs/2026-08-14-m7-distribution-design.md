# crossweave M7 — Distribution: install script, release pipeline, self-update — Design Spec

**Date:** 2026-08-14
**Status:** Approved for planning
**Depends on:** M0–M6b (merged). Continues the milestone numbering — M7 is the
"Distribution" sub-project split out of the original design doc's V1 M6
scope (TUI dashboard, deferred to M8 — see that decision below).

---

## 1. Positioning

Today crossweave only runs from a source checkout: clone, `bun install`,
`bun run scripts/build.ts`. That's fine for this project's own development,
but it's not something anyone else can adopt in under a minute, and there's
no way for an existing install to learn a newer version exists.

M7 closes that gap with the smallest thing that actually works:

1. A **release pipeline** that turns a git tag into downloadable binaries.
2. An **install script** — `curl | sh`, no runtime required — that fetches
   and installs them.
3. A **self-update check** built into `cw` itself — silent, cached, opt-out,
   never auto-installs without asking.
4. A **project website** — separate repo, separate deploy — that hosts the
   pitch and the install command.

### Non-goals (V1)

- Not auto-installing an update without the user's say-so (decided in
  brainstorming — silent background check, explicit `cw update` to apply).
- Not a package-manager tap (Homebrew formula, apt, etc.) — a real
  possibility later, out of scope here; the install script and release
  artifacts are designed so a tap can consume them later without rework.
- Not npm publish — the user picked `curl | sh` + GitHub Releases
  specifically to keep the "zero runtime dependency" property the original
  design doc already committed to (§7: "no `postinstall` script ever runs
  on a user's machine").
- Not Windows — matches the existing POSIX-only constraint (§7 of the V1
  design doc); the install script and binaries target macOS and Linux only.
- Not the website's own content/design in detail — it's a separate repo the
  user creates and owns; this spec only fixes the one contract the CLI
  side depends on (the install command's exact text) so the two repos never
  drift out of sync silently.

## 2. Architecture

```
 git tag vX.Y.Z ──push──> GitHub Actions ──build matrix──> GitHub Release
                                                             (cw-*, cwd-*
                                                              + checksums)
                                                                  │
                                                                  ▼
 user's shell ◀── curl | sh ──── install.sh (this repo, root) ───┘
      │
      ▼
 ~/.local/bin/cw, ~/.local/bin/cwd, ~/.crossweave/config.json (installed_version)

 cw (any command) ──background, cached, opt-out──> GitHub Releases API
      │                                              (latest tag)
      ▼
 "newer version available — run `cw update`" (never auto-applies)
```

Three independent pieces, each replaceable without touching the others:
the release pipeline only needs to produce a Release with a predictable
asset-naming convention; the install script and the self-update checker
both only need that convention, not each other or the pipeline's internals.

## 3. Versioning

Semver, driven by `package.json`'s `version` field and a matching git tag
`v<version>` (e.g. `v0.1.0`). A push of a `v*` tag is the pipeline's only
trigger — no version bump happens automatically; bumping `package.json`
and tagging is a manual, deliberate release action (out of scope here to
automate further, e.g. via conventional-commits-driven versioning — the
project is pre-1.0 and releases are infrequent enough that manual is
correctly the least amount of process for now).

## 4. Release pipeline (GitHub Actions)

New workflow file `.github/workflows/release.yml`, triggered on tag push
matching `v*`:

1. Checkout, install Bun.
2. Build matrix — one job per target:
   - `darwin-arm64`, `darwin-x64`, `linux-x64` (matches `bun build --compile
     --target=<target>`; the existing `scripts/build.ts` already knows how
     to produce `dist/cw`/`dist/cwd` for the host target — this workflow
     extends it to accept a `--target` passthrough, one new flag, not a
     rewrite).
3. Rename each target's output to the asset-naming convention the install
   script and self-update checker both rely on:
   `cw-<target>`, `cwd-<target>` (e.g. `cw-darwin-arm64`).
4. Copy `install.sh` (repo root, §5) into the release assets unchanged —
   this is the exact copy `cw update` pins to and downloads later (§5),
   so it must ship with every release, not just live on `main`.
5. Compute `sha256sum` for every asset — every `cw-*`/`cwd-*` binary AND
   `install.sh` itself — written to one `checksums.txt`.
6. Create (or update, if re-running a tag) a GitHub Release for that tag,
   attach every binary, `install.sh`, and `checksums.txt`. Release notes:
   the tag's annotated-tag message, if any, else left blank for manual
   editing — not auto-generated changelog in V1.

## 5. Install script

`install.sh` at the repo root (not `scripts/` — this needs a stable,
memorable raw-GitHub URL, and `scripts/` already holds this project's own
dev tooling with a different audience).

```
curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/install.sh | sh
```

Behavior:

1. Detect OS (`uname -s`) and arch (`uname -m`), map to the release
   asset-naming convention (§4). Unsupported combination (e.g. Windows,
   `arm64` Linux) → print a clear one-line error naming what's missing and
   exit non-zero — never silently fall back to a wrong binary.
2. Resolve the latest release via the GitHub API
   (`https://api.github.com/repos/<org>/<repo>/releases/latest`) unless
   `CW_INSTALL_VERSION` is set in the environment (pins a specific
   version — used by the self-update path, §6, so both share one code
   path instead of two separately-maintained download implementations).
3. Download `cw-<target>`, `cwd-<target>`, and `checksums.txt` for that
   release into a temp directory.
4. Verify both binaries' sha256 against `checksums.txt` — **hard fail,
   delete the temp download, and exit non-zero on any mismatch.** This is
   the one non-negotiable security control in this design: a script that
   pipes straight to `sh` and later swaps a running system's binary must
   never install bytes it can't verify came from that exact release.
5. Install to `~/.local/bin` (create if missing), `chmod +x` both. If
   `~/.local/bin` isn't on `PATH`, print the one-line export a user needs
   to add — never silently mutate their shell rc file.
6. Write `{"installedVersion": "<tag>"}` to `~/.crossweave/config.json`
   (creating the file/dir if absent; merge if it already has other keys —
   see §7 for what else lives there).

`cw update` (new CLI command) is a thin wrapper: download that target
release's own `install.sh` copy (§4 step 4) and its `checksums.txt`,
verify `install.sh` itself against its checksum before running it (the
same non-negotiable rule as §5 step 4, applied one layer up — `cw update`
must not execute an unverified script any more than `install.sh` installs
an unverified binary), then run it with `CW_INSTALL_VERSION` pinned to
whatever the cached check (§6) found. One download-and-verify
implementation, not two — and updating a possibly-old install never
depends on whatever `main` looks like today, only on that release's own
pinned, checksummed copy.

## 6. Self-update check

**Where the setting lives:** a new global file, `~/.crossweave/config.json`
— deliberately separate from the existing per-repo `crossweave.config.json`
(workspace-scoped: Safe Mode tier, budget defaults, notify preferences).
Update-checking is a property of the installed binary itself, not of any
one repo/workspace, so it doesn't belong in a file `cw init` writes per
project. Shape:

```json
{
  "installedVersion": "v0.1.0",
  "updateCheck": true,
  "lastCheckedAt": "2026-08-14T12:00:00.000Z",
  "lastKnownLatest": "v0.1.0"
}
```

`updateCheck` defaults to `true` (matches this project's existing default —
notify M6b shipped "default ON, disable via config" the same way).
`cw config update-check on|off` (new subcommand, mirrors `cw config notify
on|off`'s existing shape) flips it.

**When it checks:** on any `cw` invocation, after the command's own work —
never blocking the command itself. Skipped entirely if `updateCheck` is
`false`, or if `lastCheckedAt` is under 24h old (the cache is exactly what
keeps this off the GitHub API's unauthenticated 60-req/hour rate limit —
a single local install checking at most once a day is nowhere near it).
The check itself: `GET
https://api.github.com/repos/<org>/<repo>/releases/latest`, compare its
tag against `installedVersion` (semver comparison, not string equality —
a `v0.10.0` must sort after `v0.9.0`). Network failure or non-2xx response
is swallowed silently (same posture as M6b's notify-degrade philosophy —
"observability, not a safety mechanism," never surfaced as an error to an
unrelated command) and does not update `lastCheckedAt`, so the next
invocation retries rather than waiting out the full 24h on a transient
outage.

**What the user sees:** if `lastKnownLatest` (after a fresh check) is newer
than `installedVersion`, the NEXT command's output gets exactly one
trailing line: `crossweave: vX.Y.Z is available (you have vA.B.C) — run
'cw update' to install it.` Printed at most once per cached check, not
once per command — a `lastNotifiedVersion` field (added to the same file)
tracks whether this specific version was already announced, so leaving
`updateCheck` on doesn't nag on every single command once a new version
exists.

## 7. Website

Separate repo (name/URL: user's choice, not fixed by this spec). The one
thing this spec fixes so the two repos can't silently drift: the install
command's exact text (§5's `curl -fsSL .../install.sh | sh` line) is the
single source of truth on the `crossweave` repo's own README, and the
website MUST pull or mirror that exact line rather than hand-typing its
own copy — a follow-up task in that repo's own plan, not this one.
Content, framework, hosting, and domain are that repo's own design
decision when the user is ready to start it; not further specified here.

## 8. Testing

- **Version-comparison logic** (semver parse + compare, used by both the
  install-script-equivalent-in-TS path if any and the self-update checker)
  is plain TypeScript — unit-tested the normal way, `bun test`, no network,
  no clock (inject "now" the same way the rest of this codebase already
  does — see `NotificationGate`'s clock-injectable pattern).
- **The update-check cache logic** (24h gate, `lastNotifiedVersion`
  dedup) is also plain TS against an injectable clock and a fake HTTP
  fetch — no real network in `bun test`, matching this project's existing
  "tests must be deterministic" rule.
- **`install.sh` itself** is bash, outside `bun test`'s reach. It gets a
  smoke-test checklist run manually before each release (documented in
  the plan, not automated in V1): fresh macOS, fresh Linux, unsupported
  arch (expect a clean error, not a wrong binary), a deliberately corrupted
  checksum (expect a hard failure, not a silent install). Automating this
  via a container-based CI job is a reasonable follow-up, not required for
  V1 — flagged here so it isn't forgotten, not deferred silently.
- **The GitHub Actions release workflow** is verified by actually cutting
  a real tag during implementation (a real `v0.0.1-rc1`-style pre-release,
  deletable afterward) rather than guessed at from reading YAML — the plan
  must include this as an explicit step, not skip straight to trusting the
  workflow file compiles.

## 9. Security

- Checksum verification (§5.4) is load-bearing, not optional — this is the
  one place in the whole design where a compromised or MITM'd download
  becomes an arbitrary-code-execution vector on the user's machine (both
  at install time and at every future `cw update`).
- The install script is served over HTTPS from `raw.githubusercontent.com`
  (GitHub-operated, not the project's own infrastructure) — no separate
  hosting to secure or that could be compromised independently of GitHub
  itself.
- `cw update` never runs with elevated privileges and never touches
  anything outside `~/.local/bin` and `~/.crossweave/` — no `sudo` anywhere
  in this design.
- The self-update checker only ever reads GitHub's public releases API —
  no write access, no token, no auth required or accepted.

## 10. Milestone numbering

This is **M7**. TUI (the dashboard half of the original design doc's V1 M6
scope) is **M8**, brainstormed next per the user's explicit ordering
decision (Distribution first — it unlocks anyone else installing
crossweave at all; TUI only benefits someone already running it).
