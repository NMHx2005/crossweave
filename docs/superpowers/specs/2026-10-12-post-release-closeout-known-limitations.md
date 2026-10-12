# Post-release closeout — known limitations

## Verified

- PR [#3](https://github.com/NMHx2005/crossweave/pull/3) merged linearly into `main` at `337745e`.
- CI run [38233978753](https://github.com/NMHx2005/crossweave/actions/runs/38233978753) passed Linux typecheck/root and website tests, plus macOS Cockpit build/tests.
- Pages run [38234215498](https://github.com/NMHx2005/crossweave/actions/runs/38234215498) passed. Live `robots.txt`, all 12 sitemap entries, homepage canonical, and EN/VI/x-default alternates use HTTPS on `crossweave.dev`.
- Safari on macOS loaded the live page, started the demo muted under normal motion, and toggled the Pause/Play control. The repository Website field now points to `https://crossweave.dev/`; README links directly to the site, and no old `github.io` URL was found there.

## Still open

- Ask an independent Vietnamese-fluent human to proofread `website/src/content/vi.ts`. The code-side clarity review does not count as that sign-off.
- Firefox is not installed in the available app inventory. Firefox playback is untested. Safari reduced-motion and JavaScript-disabled playback were not repeated manually; those contracts are covered by tests.
- Apple notarization remains deferred by the owner.
