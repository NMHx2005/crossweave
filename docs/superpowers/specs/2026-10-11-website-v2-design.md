# crossweave website v2 — a story-led home page and a demo clip

An amendment to `2026-10-11-website-design.md`, decided after two independent reviews (Codex and an Opus subagent) of the first version against Orca, Conductor, Linear,
Warp, Zed and Cursor, and after the owner chose the full scope (2026-10-11). The first version is honest and technically clean but reads as an engineering ledger: twelve dense
cards, no "how it works", a hero picture that is mostly empty, a download button that leads into the not-notarized trap, no proof of life, no audience, no security page.

Everything below keeps the standing rules: no invented proof (no testimonials, logos, star badge, Discord/X, fake numbers), every claim carries its qualifier, nothing
depends on JavaScript to be readable, the CSP only ever loosens by what is named here.

## A. Information architecture of the home page

Order: **announcement pill → hero (headline, subtitle, install line with copy button, app download, GitHub; the clip) → How it works (diagram, three steps with stills) →
What you get (four short groups; released features only) → Coming in vX (unreleased features, only while there are any) → Is it for you? → works with your agents →
comparison → recent releases → FAQ → closing call to action.** The removal history (v0.3-radar etc.) moves to the changelog; "Why crossweave?" (the warp and weft) becomes a FAQ answer.

- **Headline stays** the owner-approved *Many agents. One repo. Land what holds up.* The subtitle now defines the word and names the audience: *crossweave gives each coding
  agent its own git worktree and shell, shows which one is working, asking or done, and trial-merges them in the background so you land (merge back) only what holds up.
  For developers who already run Claude Code, Codex or Gemini in more than one terminal.*
- **Announcement pill** above the hero, generated: while any feature is newer than the latest published release, `Coming in v0.6.0: checkpoints, diff comments, tests after each turn →`
  linking to the changelog entry; absent otherwise.
- **Calls to action:** primary is the installer line (macOS and Linux) with a **Copy** button; secondary is `Download the app — macOS, Apple Silicon` (to the Download page, which
  explains the missing notarization before the file); then `GitHub`. The "Install the CLI" jump button is removed. The hero meta line reads `v0.5.0 · 30 Sep 2026 · What's new →`
  (version, date, link to that changelog entry).
- **How it works:** a small inline SVG diagram (main, three session lanes, a trial merge, a land) and three steps, each with one command, one sentence and a still taken from the clip:
  1 *Start sessions* — `cw session new api` — its own worktree, branch and port block; 2 *Run your agents* — `claude`, `codex` or your own command in each shell — the rail shows who
  is working, asking or done; 3 *Land what holds up* — `cw converge status`, then `cw land` — trial merges run in the background and show what merges clean and in what order.
- **What you get:** four groups, **Run** (sessions, presets, composer), **Watch** (the rail, the debug pane, the browser pane), **Land** (landing, compare), **Review** (checkpoints, diff
  comments, tests after each turn, risky-file flags). Each card is a title and **one sentence**; its qualifier and a link to the full limitations sit in a `Limits` disclosure. A group
  shows only released features; features newer than the latest release go to the **Coming in vX** strip, in the same card style, and join their groups by themselves when released.
- **Is it for you?** Two short columns. For you: you run two or more agents on one repo; you are at home in git and a terminal; you want to see state at a glance and land on evidence.
  Not for you: you need Windows; you want an IDE; you want the tool to pick, sandbox or supervise the agent; you want to drive it from a phone (a native iOS app is planned).
- **Recent releases:** the last three published releases with their dates and the first sentence of each release's *Headline* (from `docs/releases`), and one line `In development: v0.6.0`
  while an unreleased tag exists. Dates come from a committed `website/release-dates.json` that `--refresh-release` appends to.
- **Comparison table:** five rows, no dismissive wording, with the line `Status is inferred from terminal activity; accuracy varies by agent` kept.
- **FAQ** gains: *Do I need the app, or is the CLI enough?*, *What does landing do to my base branch?*, *How is it different from agent IDEs?* (answered by category, no product named),
  *How much disk do worktrees take?*, *Why "crossweave"?* The uninstall answer becomes two sentences and a link to a new **Uninstall** section of the Install docs page.
- **Closing call to action:** `Read the quickstart` and the install line.

## B. New and changed pages

- **Security & privacy** (`/docs/security/`, English): rendered from `SECURITY.md` (whose "Supported version … 0.4.x" line is stale and is fixed to "the latest release"), with a short
  site-written lead of what is and is not sent anywhere. It joins the docs sidebar and the footer.
- **Footer** in three groups — Product (Download, Docs, Changelog), Project (GitHub, Issues, Security, Contributing, Licence), and the version/line — and a line of who it is by:
  *Built by one developer for daily use. Bugs and ideas: GitHub Issues.*
- **Changelog** shows the date of every published release (from `release-dates.json`), not only the latest.
- **Header on a phone:** Download, Docs, Changelog and the language switch; GitHub moves to the footer; every target at least 44 px high. The header stays sticky.
- **Accessibility fixes:** the skip link sits above the sticky header; a block that is waiting to be revealed is revealed the moment something inside it takes focus (`:focus-within`);
  the navigation landmark labels are localised.
- **Sharing:** a 1200×630 Open Graph card with the headline, `og:image` width, height and alt, `theme-color`, an apple-touch-icon, and `SoftwareApplication` JSON-LD
  (price 0, MIT, macOS and Linux, no rating). The JSON-LD is a data block, not a script, so the CSP does not apply to it.
- **Copy:** the Vietnamese page is re-translated for the changed strings with a stated glossary (git terms stay); `Land cái đứng vững` becomes `Nhiều agent. Một repo. Merge cái đứng vững.`
  with the subtitle defining *land*. Still to be proofread by the owner.

## C. The clip

A scripted demo on a made-up project (acme-api), **about 30 seconds, 1920×1080, 30 fps, no audio**, H.264 in MP4 with a poster, under 4 MB, autoplaying muted and looping with
`playsinline`; with reduced motion it is paused (a script pauses it and shows controls) and the poster shows. A caption under it says what it is: *A scripted demo on a made-up project:
the sessions, commits and merges are real, the agent output is scripted.* A collapsible text version of the story sits under it for readers who cannot see it.

Style (after Cursor's product videos): the app floats as a window with rounded corners and a shadow on a flat dark backdrop with faint warp-thread lines in the four agent colours;
a visible mouse cursor with click ripples; a **camera** that eases between scenes — wide, then zooming and panning to wherever the action is — and eases back out; short captions in a constant size
near the action, each with its step number; a title card at the start and an end card (`crossweave — Many agents. One repo. Land what holds up.`, `Free · MIT · macOS and Linux`).

Story (all real tool behaviour, scripted agent screens): 1 three sessions appear in the rail, each with its own worktree and shell *(zoom on the rail)*; 2 agent screens fill, the rail's marks
change — one working, one asking (amber), one done (✓) *(zoom on the rail and a pane)*; 3 the cursor opens the done session's changes, a sensitive-file badge shows *(zoom on Changes)*;
4 `converge status`-style evidence shows two sessions merge clean and one conflicts *(zoom on the chips)*; 5 the cursor lands one session; it leaves the rail *(zoom on the Land chip and the toast)*;
6 zoom out; end card.

How it is made (`apps/cockpit/scripts/site-video.ts`, committed with the assets): the real cockpit runs on a scratch HOME and scratch repository; the script drives it over CDP, wraps the app in
an in-page *stage* (backdrop, a transformed camera layer holding the window and the cursor, constant-size captions and cards above it), and renders **frame by frame** — for each 1/30 s it sets the
camera, cursor and caption state for that instant, fires any real action due, and captures a PNG at 2× — so the motion is exactly timed whatever the capture speed. `ffmpeg` then encodes the PNG sequence
to MP4 (H.264, `yuv420p`, `+faststart`), extracts the poster and the step stills. The tool needs `ffmpeg`; nothing is added to the repository's runtime or to the website's build (the website only
serves the committed files).

## D. Security of the change

`script-src 'self'` stays; the CSP gains `media-src 'self'` and nothing else. The site script (`reveal.js`, renamed `site.js`) gains the copy button and the reduced-motion pause for the video,
still no dependency and no inline script.

## E. Tests

Home order and every new section by markup; the pill present only while something is unreleased; the groups hold released features only and the strip the rest; the release strip and the
dates; the footer groups; the Security page built from `SECURITY.md` and listed in the sidebar; the skip link's stacking and `:focus-within` reveal in the stylesheet; the 44 px targets; the JSON-LD and
the share tags; the copy button and the reduced-motion pause against a stub DOM; the media element's attributes and the CSP; English/Vietnamese parity for every new key; the build still byte-identical.
Live on the running site: the clip plays and loops, the poster shows with reduced motion, the copy button copies, 320 px has no overflow, the header stays on a phone.

## F. Limitations to record

The clip is a scripted demo and says so; its captions are English only; its camera and cursor are drawn by the script, not captured from a person; a 4 MB file is committed to the repository; the stills
are the same footage; no audio or voice-over; no testimonials, logos, star count or community links because none exist; reduced motion is checked in the stylesheet and the script's stub only, not in a
browser that can set the preference; Firefox lacks scroll-driven animation and cross-page transitions, which degrade silently.
