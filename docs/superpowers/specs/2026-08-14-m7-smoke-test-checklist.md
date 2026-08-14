# M7 install.sh — manual smoke-test checklist

Run once against a real release before announcing it, and again any time
`install.sh` itself changes. Not automated (spec §8) — bash driving real
network downloads and a real filesystem install isn't something `bun test`
covers.

- [ ] Fresh macOS (arm64): `curl -fsSL .../install.sh | sh` installs
      cleanly, `cw --version` matches the release tag.
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
