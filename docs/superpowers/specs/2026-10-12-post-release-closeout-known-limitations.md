# Post-release closeout — known limitations

## Verified

- PR [#3](https://github.com/NMHx2005/crossweave/pull/3) merged linearly into `main` at `337745e`.
- CI run [38233978753](https://github.com/NMHx2005/crossweave/actions/runs/38233978753) passed Linux typecheck/root and website tests, plus macOS Cockpit build/tests.
- Pages run [38234215498](https://github.com/NMHx2005/crossweave/actions/runs/38234215498) passed. Live `robots.txt`, all 12 sitemap entries, homepage canonical, and EN/VI/x-default alternates use HTTPS on `crossweave.dev`.
- Safari on macOS loaded the live page, started the demo muted under normal motion, and toggled the Pause/Play control. The repository Website field now points to `https://crossweave.dev/`; README links directly to the site, and no old `github.io` URL was found there.
- CI runs [38236079238](https://github.com/NMHx2005/crossweave/actions/runs/38236079238), [38236416284](https://github.com/NMHx2005/crossweave/actions/runs/38236416284), and final-main run [38236698694](https://github.com/NMHx2005/crossweave/actions/runs/38236698694) passed both jobs, including the Linux suite with new diagnostic output for a recurring fixture-copy error.
- After switching the fixture helper to synchronous copy, CI run [38237502724](https://github.com/NMHx2005/crossweave/actions/runs/38237502724) passed Linux typecheck/tests and the Cockpit build/tests.
- PRs [#3](https://github.com/NMHx2005/crossweave/pull/3), [#4](https://github.com/NMHx2005/crossweave/pull/4), and [#5](https://github.com/NMHx2005/crossweave/pull/5) are merged linearly; final-main CI run [38238096754](https://github.com/NMHx2005/crossweave/actions/runs/38238096754) passed both jobs on `ef93afd`.
- Latest Pages run [38236698702](https://github.com/NMHx2005/crossweave/actions/runs/38236698702) passed after PR #4. PR #5 changed test support and documentation only, so it did not trigger another Pages deployment.

## Still open

- Ask an independent Vietnamese-fluent human to proofread `website/src/content/vi.ts`. The code-side clarity review does not count as that sign-off.
- Firefox is not installed in the available app inventory. Firefox playback is untested. Safari reduced-motion and JavaScript-disabled playback were not repeated manually; those contracts are covered by tests.
- Apple notarization remains deferred by the owner.
- Four Linux runs failed at an asynchronous Git-fixture copy even though the last had identical source and destination trees. Replacing it with `cpSync` passed the full CI suite at `38237502724`; the exceptional recursive diagnostics remain if the symptom returns. See `2026-10-11-ci-checkpoint-stability-known-limitations.md`.
