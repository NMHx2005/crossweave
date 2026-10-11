# The crossweave website — known limitations

Spec: `2026-10-11-website-design.md`. Plan: `docs/superpowers/plans/2026-10-11-website.md`. Both were revised after a Codex review (the spec: 1 blocker, 7 major; the plan: 2
blockers, 8 major), and the finished copy was fact-checked against the repository by Codex a third time (9 major, 5 minor), which found real errors, fixed in the same
change; a fourth Codex pass read the finished code of the whole branch (3 major, 5 minor, no blocker) and its findings were fixed too: a preview-server path check that a sibling
directory with the same prefix or a symlink could defeat, a shared temp file name in the manifest refresh, a feature grid with a 304 px minimum column that left no right margin at 320 px,
fence parsing that closed a four-backtick block on three backticks, heading ids that could collide, README links that begin with a slash, changelog fragments, a 404 heading with no
language mark and file URLs used as paths. Earlier, the copy errors were: the site had said a launcher only drafts a line when it types it and runs it, an uninstall order that could restart a stopped daemon, a debug bundle described as
identical in the app and the CLI, and checkpoint, auto-check and Land qualifiers that were thinner than the limitations files.

## What shipped

A static site in `website/`, built by one dependency-free Bun script (`bun website/build.ts`, output `website/dist`, git-ignored) and deployed by
`.github/workflows/pages.yml` to GitHub Pages:

- **Home** (English at `/`, Vietnamese at `/vi/`): the headline, the install line, a sized screenshot, twelve feature cards each with its own qualifier and a link to its
  limitations file (a card newer than the latest published release carries an "In the next release" badge and loses it by itself), the launcher names as plain text,
  what it deliberately does not do, a comparison with doing it by hand, "why crossweave", eleven questions, a closing call to action.
- **Download** (both languages): the Cockpit `.dmg` and `.zip`, the CLI binaries, `checksums.txt` and `install.sh` straight from the release; an honest "Not notarized
  yet" box with the one command that clears the mark; what the installer does and needs. A `NOTARIZED` constant swaps the box for a plain line.
- **Docs** (English): an overview and Install, Quickstart, Cockpit and Configuration built from the README by heading, a Concepts page and a command reference whose
  list is checked against `cw --help`; every page says it follows `main` and names the latest published release.
- **Changelog** (English): every `docs/releases/v*.md`, newest first by semantic version, the unreleased one marked. **404**: one bilingual file. `sitemap.xml`;
  `CNAME` and `robots.txt` only with `SITE_DOMAIN`.

Safety and reproducibility: markdown goes through `Bun.markdown.render` with callbacks of our own (raw HTML dropped and counted, a link-scheme allow-list, images only from
the site's own copies, text escaped exactly once); a content security policy meta tag first in every `<head>`, one external script (`site.js`, which also runs the copy button and the demo clip's Pause/Play), `media-src 'self'` and no inline executable script, style or handler; release data from
a committed manifest (`website/release.json`) that `--refresh-release` replaces only with a complete, validated answer (a race-based deadline, an atomic write);
two builds of one commit are identical file for file; the build clears only a directory it made.

## Verified

162 tests in `website/tests` (run by the root `bun test`; the typecheck covers `website/` too): the hand-authored markdown golden, hostile markdown, escaping, every
internal link and fragment resolving in the built output, no cross-origin resource, the one script and no inline one, heading levels, title length, image sizes, hreflang only on translated pages,
two identical builds, the refresh failing in nine ways without touching the manifest, a custom domain without the base path, WCAG AA of every text/background pair in both
colour schemes, the copy's English and Vietnamese halves matching, every feature's limitations file existing, the command list equal to `cw --help`. By eye, on the
running site: Home (desktop, dark and light, English and Vietnamese, and at 390 px), Download, a docs page and the changelog, and no horizontal overflow at 320 px on Home,
Download and the Cockpit docs page, which holds the widest content.

## Motion

The site moves like the owner's portfolio (see the spec's Motion section): the headline's words, the hero's lines and screenshot on load; blocks and cards revealed on scroll; the
FAQ opening; a header that stays at the top as you scroll (it drops in on load, and the scroll-progress bar is its bottom edge; on a phone it is compacted to two rows, about 80 px, because it travels with you); a page cross-fade; hover lifts. **The content is visible unless `reveal.js` has armed itself**, and reduced motion gets none of it. Checked on the running
site in Chrome: armed, blocks below the fold at opacity 0 until scrolled to and 1 after, the whole page scrolled with every block revealed, a cumulative layout shift of 0, no long task,
the progress bar bound to the scroll. The tests pin the contract (the script's four behaviours against a stub DOM, every hiding rule under the armed attribute and under
`no-preference`, only cheap properties in the keyframes, the delays in the stylesheet, the markup hooks).

- **Reduced motion and Firefox were not looked at in a browser**: the reduced-motion rules are checked in the stylesheet only (the preview tool cannot emulate the preference). Cross-page
  fades, the scroll-progress bar and the smooth FAQ need Chrome-family or recent Safari features and simply do not happen elsewhere; nothing depends on them.
- The reveal needs JavaScript to hide and to show; without it everything is simply there.
- The one script is a second thing the content security policy now allows (`script-src 'self'`); there is still no inline script and no third-party one.

## Limitations

- **Not notarized.** A `.dmg` or `.zip` downloaded in a browser will normally be refused by macOS until the mark is cleared; the installer path avoids it. The site says so.
- **Docs and the changelog are English only**; the Vietnamese pages link to them and say so. **The Vietnamese copy was written by the assistant and has not been proofread
  by the owner.**
- **The docs follow `main`, the downloads follow the latest release.** Until `v0.6.0` is published, the manifest names `v0.5.0` and the docs describe things that are not in
  that download; each docs page says so and the home page badges the affected features. The manifest is refreshed at deploy time; a failed refresh keeps the committed one
  without a message on the page, so a deploy can show a stale version.
- **The workflow cannot be run locally.** `configure-pages@v5`, `upload-pages-artifact@v3` and `deploy-pages@v4` are the official actions at their versions as the
  assistant knew them; they could not be confirmed offline. The YAML parses; nothing has been deployed. `workflow_run` success does not mean CI passed, so the workflow runs
  the website tests itself.
- **`Bun.markdown` is an unstable API.** It is pinned (Bun 1.3.14), every element has a callback of ours and the golden test notices a change; a construct the callbacks do
  not know degrades to its text rather than failing.
- **GitHub Pages cannot send headers**: the content security policy is a meta tag and cannot enforce `frame-ancestors`; there is no HSTS of our own. A project site's
  `robots.txt` is not read at the origin root, so one is written only for a custom domain.
- **(Superseded by `2026-10-11-website-v2-known-limitations.md`: the home page now has a demo clip.) No video or recorded demo**; the comparison is with doing it by hand, no named product. Light and dark follow the system and there is no toggle. The hero screenshot is dark in
  both schemes.
- **Visual coverage is a sample**: not every page in both schemes and in Vietnamese, and 200 % text zoom was not checked.
- `install.sh` printed a bubblewrap warning for a sandbox removed on 2026-09-27; fixed in this change, but it reaches users only with the next release.

## Owner steps (nothing here was done by the assistant)

Merge the branch; in the repository settings choose Pages → Source: GitHub Actions; push `main`. Optional: a custom domain (DNS, the Pages setting and the `SITE_DOMAIN`
repository variable, which the workflow does not read yet — set it as an environment variable on the build step); proofread `website/src/content/vi.ts`; publish `v0.6.0` and,
when there is an Apple Developer account, notarize and flip `NOTARIZED`.

## Ideas not built

A demo video, a screenshots gallery, a docs search, a changelog feed, `llms.txt`, a theme toggle, translating the README, per-feature pages, a "Why not X" comparison with named tools
(deliberately avoided: it would need facts about other products).
