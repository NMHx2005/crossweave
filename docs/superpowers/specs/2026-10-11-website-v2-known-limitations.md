# The website, second version — known limitations

Records what `docs/superpowers/plans/2026-10-11-website-v2.md` shipped on `feat/website`, and what it did not. It supersedes the statements of
`2026-10-11-website-known-limitations.md` that disagree (see "What changed from the first version").

## What shipped

- **A story-led home page**: headline, a sized demo clip with a note and a written description, a four-line "how it works" (an inline diagram and three
  steps with a command and a picture each), the twelve features grouped as Run / Watch / Land / Review with one sentence each (the limits behind a
  disclosure), a "Coming in v0.6.0" strip, "Is it for you?", a comparison of five rows, sixteen questions, a recent-releases strip with dates.
- **A demo clip** (`website/public/media/demo.mp4`, 1920×1080, 41 s, H.264, no audio, about 1.3 MB) with a poster, three step pictures and a share card,
  all filmed from the running Cockpit by `apps/cockpit/scripts/site-video.ts` (floating window, camera zoom, a visible cursor, five numbered captions).
  It plays by itself, muted and looping, with no browser controls; a Pause/Play button (hidden until the script runs) is the only control. It pauses
  while off screen, and with reduced motion it stays on the poster until the button is pressed.
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
- **The story is staged around one rule of the product, found while filming**: the Cockpit's Land button calls `land.session` without `force`, so
  landing a session whose shell is still running fails with `SESSION_STILL_LIVE` ("Stop it first, or pass --force"), and the background trial merges
  only classify running or idle sessions. The clip therefore stops the finished session (`session.stop`, which leaves it idle, still classified and
  landable) before the land. A person who never stops a session sees the error toast. This is a gap in the product, not in the site; it is not fixed
  here.
- **A fixed take, not a recording of a live session**: timing is authored (gates hold the clock until a real condition holds), the cursor re-reads its
  target while it moves, and a take is checked by eye. Re-filming needs a scratch HOME and repository, macOS, ffmpeg and the steps in
  `apps/cockpit/README.md`.

## Limitations

- **The clip shows English captions only.** The Vietnamese page carries the same clip; its note and written description are Vietnamese.
- **Without script the clip still plays** (the `autoplay` attribute), with no way to pause it; with script and reduced motion it is paused on its first
  frame by the script, so a reduced-motion reader may see a flash of motion before it stops. The button is hidden without script. The page's other
  motion is unchanged: nothing is hidden unless the script has armed it.
- **The clip's weight is 1.3 MB**, loaded with the page (`preload="metadata"` plus autoplay); there is no lazy start below the fold other than the
  script's pause when it is off screen.
- **The toggle covers part of the clip on a 320 px screen** (about half its width, 44 px high).
- **The share card is one picture** for the home page; the other pages keep their screenshot.
- **Vietnamese is still unproofread** by a native reader; the new strings follow the first version's glossary.
- **Not checked in a browser**: reduced motion on the new page, Safari and Firefox playback of the clip, 200 % text zoom.
- **The pictures are frames of one take**, so they show the app at the moment of that take (names such as `acme-api`, `burst-cap`, made up).

## What changed from the first version

- "No video or recorded demo" is gone; the hero is the clip. The hero screenshot is no longer on the home page (the file stays for other pages).
- The home page's one external script now also drives the clip (Pause/Play and the pause while off screen); `media-src 'self'` was added to the
  content security policy; there is still no inline script and no third-party resource.
- The diagram's verdict marks show one session merging clean and two colliding, as the clip does.

## Owner steps (nothing here was done by the assistant)

Merge `feat/website` into `main` (fast-forward), enable GitHub Pages (Source: GitHub Actions), push, tag and push v0.6.0, proofread
`website/src/content/vi.ts`, and decide whether to fix the Land-on-a-running-session gap above.
