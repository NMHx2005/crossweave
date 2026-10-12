# The website, second version — known limitations

Records what `docs/superpowers/plans/2026-10-11-website-v2.md` shipped on `feat/website`, and what it did not. It supersedes the statements of
`2026-10-11-website-known-limitations.md` that disagree (see "What changed from the first version").

## What shipped

- **A story-led home page**: headline, a sized demo clip with a note and a written description, a four-line "how it works" (an inline diagram and three
  steps with a command and a picture each), the twelve features grouped as Run / Watch / Land / Review with one sentence each (the limits behind a
  disclosure), a "Coming in v0.6.0" strip, "Is it for you?", a comparison of five rows, sixteen questions, a recent-releases strip with dates.
- **A demo clip** (`website/public/media/demo.mp4`, 1920×1080, 41 s, H.264, no audio, about 1.3 MB) with a poster, three step pictures and a share card,
  all filmed from the running Cockpit by `apps/cockpit/scripts/site-video.ts` (floating window, camera zoom, a visible cursor, five numbered captions).
  Native controls are the no-script baseline. After the custom Pause/Play button and motion preference are ready, the script hides native controls;
  autoplay is limited to `no-preference`, off-screen playback pauses, and reduced-motion visitors can start playback themselves.
- **A sturdier shell** (header and footer redrawn after a first look: a frosted sticky bar with pill links, the language switch and a Download button on the right; a footer with the brand, two titled link columns and a bottom line): skip link, focus styles, a phone header with 44 px targets (two rows, about 100 px, GitHub left to the footer), a footer in groups, and a **Security & privacy** page built from
  `SECURITY.md`; release dates in the manifest and the changelog.

## What the clip is, and is not

- **A scripted demo.** The commits, the trial merges, the conflicts, the Changes pane, the risky-file question and the landing are the real daemon and
  the real Cockpit. The agent screens are printed by a script into each shell, the status marks (`asking`, `done`) are sent through the daemon's
  notify call, and the three sessions are created through the daemon's `session.new` / `session.start` rather than through the New-session dialog. The
  note under the clip says so.
- **Recorded on the development build** (v0.6.0), while the site's download is v0.5.0. The note says so; the home page also says what is in the
  next release.
- **Filmed with the DOM terminal renderer.** The Cockpit's WebGL terminal draws nothing in a capture taken at a device scale other than 1, so the
  recorder makes `WebGL2RenderingContext` undefined for its own connection and the Cockpit falls back to its DOM renderer. Terminal text in the clip is
  therefore the fallback renderer's, not the one a user sees.
- **The filmed story predates the live-session Land improvement**: its finished session is stopped before landing, while the current Cockpit branch
  offers an explicit Stop and land flow for a clean, readable live worktree. The flow keeps uncommitted work, requires a separate confirmation for
  unknown convergence evidence, and preserves the worktree if a write arrives during shell shutdown.
- **A fixed take, not a recording of a live session**: timing is authored (gates hold the clock until a real condition holds), the cursor re-reads its
  target while it moves, and a take is checked by eye. Re-filming needs a scratch HOME and repository, macOS, ffmpeg and the steps in
  `apps/cockpit/README.md`.

## Limitations

- **Live sitemap scheme mismatch (observed 2026-10-11; fixed and verified 2026-10-12).** Pages run [`38234215498`](https://github.com/NMHx2005/crossweave/actions/runs/38234215498) published the fix from merge commit `337745e`. Live `robots.txt` points to the HTTPS sitemap; the sitemap lists 12 HTTPS URLs on `crossweave.dev`; the home canonical and EN/VI/x-default alternates use HTTPS. The site should be checked again after future domain or Pages workflow changes.
- **The clip shows English captions only.** The Vietnamese page carries the same clip; its note and written description are Vietnamese.
- The clip's weight is about 1.3 MB. It uses `preload="metadata"`; normal-motion autoplay begins only after script initialization, and off-screen playback pauses.
- **The toggle covers part of the clip on a 320 px screen** (about half its width, 44 px high).
- **The share card is one picture** for the home page; the other pages keep their screenshot.
- **Vietnamese copy received a code-side clarity edit but has not had the requested human proofread**; owner review is pending.
- **Browser pass, 2026-10-11–12:** Chromium on macOS, all seven core routes at 320, 375, 768 and 1280 CSS px; no document overflow, one H1 and no heading skips. Home at 200% text size also fits; its comparison table scrolls within its labelled table wrapper. Dark/mobile and light/desktop screenshots were inspected. Reduced motion leaves video paused, explicit Play and Pause work, normal motion starts muted playback, off-screen playback pauses, and disabled JavaScript leaves native controls. On all seven routes, keyboard traversal reached every one of 240 visible focusable elements; none lacked a visible focus indicator or was covered by the sticky header. The first Tab reaches “Skip to content”; all 58 home-page disclosures open and close with Enter, and English/Vietnamese copy buttons work with Enter. Safari on macOS was later smoke-tested against the live site: normal-motion autoplay started muted and Pause/Play toggled correctly. Reduced-motion and no-JavaScript fallbacks were not separately repeated in Safari. **Firefox remains untested** because it is not installed in the available app inventory. The full browser matrix is not complete.
- **The pictures are frames of one take**, so they show the app at the moment of that take (names such as `acme-api`, `burst-cap`, made up).

## What changed from the first version

- "No video or recorded demo" is gone; the hero is the clip. The hero screenshot is no longer on the home page (the file stays for other pages).
- The home page's one external script now also drives the clip (Pause/Play and the pause while off screen); `media-src 'self'` was added to the
  content security policy; there is still no inline script and no third-party resource.
- The diagram's verdict marks show one session merging clean and two colliding, as the clip does.

## Owner and integration follow-up

The site and v0.6.0 are live, and the sitemap fix has been published and verified. An independent Vietnamese-fluent human should still proofread `website/src/content/vi.ts`; Firefox playback and Safari reduced-motion/no-JavaScript checks remain open. Apple notarization stays deferred.
