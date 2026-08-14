# M7 install.sh — manual smoke-test checklist

Run once against a real release before announcing it, and again any time
`install.sh` itself changes. Not automated (spec §8) — bash driving real
network downloads and a real filesystem install isn't something `bun test`
covers.

## Cutting a real tag — read this first

**Use a lightweight tag (`git tag vX.Y.Z`), not an annotated one
(`git tag -a`).** Verified empirically on this repo (2026-08-14, the
`v0.0.1-rc1` pipeline smoke test): an annotated tag pushed to
`NMHx2005/crossweave` was accepted by GitHub (visible via
`git ls-remote`/the repo's Tags page) but never triggered the `release`
workflow at all — no run, no error, no banner, `0 workflow runs` forever.
Deleting it and re-pushing the exact same version as a lightweight tag
triggered the workflow within seconds. This isn't documented GitHub
behavior and may be specific to this account/repo — but until it's
understood, tag every real release with a plain `git tag vX.Y.Z`.

`package.json`'s `version` field must exactly match the tag (minus the
`v` prefix) before pushing — the `verify-version` job (Important 4's
fix) hard-fails the whole pipeline otherwise, by design.

## Checklist

- [x] Fresh macOS (arm64): `curl -fsSL .../install.sh | sh` installs
      cleanly, `cw --version` matches the release tag. **Verified for
      real against `v0.0.1-rc1`** (2026-08-14) — real GitHub release,
      real download, real checksum verification pass, `cw --version`
      printed `0.0.1-rc1` with no extraneous output, `config.json`
      written with the correct shape. Run in an isolated `$HOME`/
      `$CW_INSTALL_DIR`, cleaned up after.
- [ ] Fresh macOS (x64, e.g. Rosetta or an Intel machine): same.
- [ ] Fresh Linux (x64): same.
- [ ] Unsupported arch (e.g. Linux arm64): script exits non-zero with a
      clear message, nothing installed.
- [ ] Deliberately corrupt one byte of a downloaded binary before checksum
      verification runs (or point `checksums.txt` at the wrong file):
      script hard-fails, nothing is moved into `$INSTALL_DIR`.
- [ ] `checksums.txt` missing the target's entry entirely → hard-fail,
      nothing installed.
- [ ] No `sha256sum` or `shasum` on `PATH` → clean error, nothing
      installed.
- [ ] Re-run install after `cw config update-check off`: the reinstalled
      config.json still has `updateCheck: false`, not reset to `true`.
- [ ] `~/.local/bin` not on `PATH`: script prints the export line, doesn't
      silently edit any shell rc file.
