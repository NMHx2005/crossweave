# Post-release closeout — known limitations

## Verified

- PR [#3](https://github.com/NMHx2005/crossweave/pull/3) merged linearly into `main` at `337745e`.
- CI run [38233978753](https://github.com/NMHx2005/crossweave/actions/runs/38233978753) passed Linux typecheck/root and website tests, plus macOS Cockpit build/tests.
- Pages run [38234215498](https://github.com/NMHx2005/crossweave/actions/runs/38234215498) passed. Live `robots.txt`, all 12 sitemap entries, homepage canonical, and EN/VI/x-default alternates use HTTPS on `crossweave.dev`.
- Safari on macOS loaded the live page, started the demo muted under normal motion, and toggled the Pause/Play control. The repository Website field now points to `https://crossweave.dev/`; README links directly to the site, and no old `github.io` URL was found there.
- CI runs [38236079238](https://github.com/NMHx2005/crossweave/actions/runs/38236079238), [38236416284](https://github.com/NMHx2005/crossweave/actions/runs/38236416284), and final-main run [38236698694](https://github.com/NMHx2005/crossweave/actions/runs/38236698694) passed both jobs, including the Linux suite with new diagnostic output for a recurring fixture-copy error.

## Still open

- Ask an independent Vietnamese-fluent human to proofread `website/src/content/vi.ts`. The code-side clarity review does not count as that sign-off.
- Firefox is not installed in the available app inventory. Firefox playback is untested. Safari reduced-motion and JavaScript-disabled playback were not repeated manually; those contracts are covered by tests.
- Apple notarization remains deferred by the owner.
- A separate Linux CI flake remained unresolved on this commit: four attempts (the initial run and rerun of `38234721338`, `38235758485`, and `38237062012`) failed at one Git-fixture `cp()` with `ENOENT`. The last showed identical full source and destination trees when it threw. A follow-up now tries synchronous copy; its CI result will determine whether this is resolved. See `2026-10-11-ci-checkpoint-stability-known-limitations.md`.
