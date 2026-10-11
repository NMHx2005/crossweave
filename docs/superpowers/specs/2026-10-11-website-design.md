# crossweave website — design

A public site for crossweave in the manner of Orca's (a product page with a download, a feature grid, a comparison, a FAQ, docs and a changelog) but
in crossweave's own register: a personal, free, MIT tool that says plainly what it does and what it deliberately does not. Decided with the owner on
2026-10-11: a **standalone site** (not part of spacevibe.dev, which is not the owner's), **full scope** (home, download, docs, changelog, FAQ, comparison),
**no Apple notarization yet** (so the download page is honest about it), English first with Vietnamese alongside.

## Goals and non-goals

- A visitor understands in ten seconds what crossweave is, sees the app, and can install it in one command or one download.
- Every claim on the page is one the repository can back (README, `docs/PROGRESS.md`, the known-limitations files). Nothing is promised that is not built.
- Zero runtime dependencies, no third-party scripts, fonts or images, no cookies, no tracking, works with JavaScript off.
- Not in scope: pricing, enterprise, a blog, analytics, search, a mobile app section, Discord/X (the owner has none to link), third-party logos, a video
  (none exists; a slot is added when one does), a custom domain (supported by a variable, not chosen), Apple-notarized download (a constant flips the copy).

## Approach

A Bun script (`website/build.ts`) renders static HTML from typed content modules (English and Vietnamese) and from markdown that already lives in the repository.
Markdown goes through Bun's built-in `Bun.markdown.render` with **our own complete set of callbacks** (no markdown library to add), never through `Bun.markdown.html`:
a probe on Bun 1.3.14 showed that `html()` keeps an `onerror` attribute on a raw `<img>` and a `javascript:` link, and the API is documented as unstable. The callbacks
escape all text, drop raw HTML (the `html` callback returns an empty string), allow link schemes `https:`, `http:`, `mailto:`, relative paths and fragments only,
allow images only from the site's own `/img/`, and escape every attribute. The workflow pins Bun 1.3.14 (as `release.yml` does) and a golden test over a fixture that
uses every construct the repository's markdown uses (headings, lists, tables, code blocks, links, images, emphasis, hostile HTML) fails loudly if the API changes.
Rejected: Astro (a large dependency tree with native pieces such as sharp and esbuild for a
static site) and Next.js (nothing here needs a server or a framework). The site is part of this repository so its words ship with the release they describe.

## Layout of the repository

```
website/
  build.ts            # the whole build: content -> HTML in website/dist
  src/content/        # en.ts (the source of truth), vi.ts (must have the same keys: the type enforces it)
  src/pages/          # home.ts, download.ts, docs.ts, changelog.ts, notfound.ts  (pure functions: content -> HTML string)
  src/layout.ts       # head, header, footer, language switch, skip link
  src/theme.ts        # CSS custom properties generated from the cockpit's own token modules
  src/styles.css      # the stylesheet (tokens only, no literal colours)
  src/release.ts      # the latest release, read from GitHub at build time with a fallback
  public/img/         # screenshots, optimised once and committed (see Images)
  tests/              # bun test
.github/workflows/pages.yml   # build and deploy to GitHub Pages
```

`website/package.json` has scripts only (`build`, `serve`, `test`) and no dependencies. The root `tsconfig` includes `website/**/*.ts` so `bun run typecheck`
covers it, and the root `bun test` runs its tests.

## Pages (Home and Download in English at `/…` and Vietnamese at `/vi/…`; Docs and Changelog in English only)

1. **Home**
   - **Hero:** the headline, a one-line subtitle, two buttons — *Download for macOS* and *Install the CLI* (the `curl … | sh` line, with a copy-free plain
     `<code>` block: no JavaScript) — a GitHub link, the version and licence, and the main screenshot.
   - **"Your dev loop"** grid of feature cards (a card whose feature is newer than the latest published release carries an "In the next release (vX.Y.Z)" badge beside its claim, and loses it by itself when the manifest names that release), each one sentence that carries its own qualifier and one link to its limitations file or docs section (a card in
     the content type has `text`, `qualifier` and `source`, and a test checks that `source` exists): sessions as worktree + shell; one
     rail that says who is working, asking or done; checkpoints around every agent turn; diff comments pasted into the shell; automatic test runs and a failed-test
     alert; sensitive-file flags before landing; trial merges and evidence-gated landing; compare two sessions; prompt composer to many sessions; debug pane;
     browser agent (Off/Read/Control); presets.
   - **Works with the agents you already run:** the launcher names as plain text (Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, Copilot CLI, Aider,
     Amp, Qwen Code, or your own wrapper), plus the sentence that crossweave never chooses, configures or launches one for you. No logos.
   - **What it deliberately does not do:** no agent model, no remote control in a browser, no in-app dictation, no collision guard or sandbox, no Windows, and what
     each removal was (with its last tag).
   - **Comparison:** two columns, *By hand (git worktree + tmux)* and *crossweave*, on rows that can be checked (one branch per agent, port/cache/DB names per
     session, what is ready to land and in which order, what the agent just changed, a record of each turn). Third-party products are not named.
   - **FAQ** (native `<details>`): what it is and is not, is it an IDE, which agents, does it choose the agent, where does my code go (crossweave itself sends nothing anywhere
     and has no telemetry: a local daemon behind one unix socket; its only network uses are the installer's download, `cw update` and the optional update check
     against GitHub; the Refine command is a program the owner of the machine names and the agents you run and the pages you open have their own network
     behaviour, which the answer says in one sentence), platforms, cost and licence, why it
     is not notarized, how to update (`cw update`), what auto-check runs, how checkpoints work, how to uninstall.
   - **Why "crossweave":** the warp and weft paragraph from the README.
   - **Closing call to action** and the footer: Download, Changelog, Docs, GitHub, Issues, MIT licence, version.
2. **Download:** the Cockpit `.dmg` and `.zip` (macOS arm64), the CLI binaries per platform (macOS arm64/x64, Linux x64) and `checksums.txt`, all linking to the
   latest GitHub release; the installer line; requirements (macOS or Linux, git, Bun is *not* needed for the compiled binaries — verified against `install.sh`
   in the plan); and an honest **"Not notarized yet"** box in conditional words: a `.dmg` or `.zip` downloaded in a browser is normally marked as downloaded from the internet and,
   being unnotarized, macOS will refuse it with a warning; files fetched with `curl` are normally not marked, and the installer fetches with `curl`. The box gives the
   exact command for an app dragged to Applications (`xattr -dr com.apple.quarantine "/Applications/crossweave Cockpit.app"`) and says what the installer really does:
   downloads and checksum-verifies `cw`/`cwd`, installs them to `~/.local/bin`, and on macOS arm64 also unpacks the Cockpit zip to `~/Applications`; it does not install
   the `.dmg`, clear any flag or use `sudo`. The manual route lists `chmod +x`, the checksum command and the installer's prerequisites (read from `install.sh` in the plan). A `NOTARIZED` constant in `src/release.ts` swaps this box for
   a plain line when it becomes true.
3. **Docs:** an index and pages built from the README by heading (**Install**, **Quickstart**, **Cockpit (desktop)**, **Configuration**): the build fails if one of
   those headings disappears, so the docs cannot silently go stale. A section runs from its `## ` heading to the next `## ` heading; its heading becomes the page's
   `h1`, sub-headings are promoted one level and get slug ids (duplicates numbered). Before rendering, the README's `<p align="center"><img …></p>` screenshot lines are
   rewritten to markdown images pointing at the site's own copies, repository-relative links (`docs/…`, `src/…`, `apps/…`) are rewritten to
   `https://github.com/NMHx2005/crossweave/blob/main/…`, and every in-page `#fragment` is checked against the slugs. Raw HTML left in a docs source (after the screenshot rewrite) and the constructs the renderer is known not to support (task lists, footnotes,
   math) fail the build; any other new construct degrades to its text, and a hand-authored golden test over the real README sections makes a visible change loud. A short "Concepts" page (session, worktree, rail, land, evidence) written for the site, and a
   `cw` command list from a committed fixture, `website/src/content/cli-help.txt`, which a test compares with the live `bun src/cli/index.ts --help` output so it cannot drift. Docs stay in English in v1 (translating the README is out of scope; the Vietnamese
   pages say so and link to the English ones).
4. **Changelog:** every `docs/releases/v*.md`, newest first, rendered from markdown, English only.
5. **404** (one bilingual `404.html`), `sitemap.xml`, `robots.txt`, a web manifest-free `<link rel="icon">` from the app icon.

## Claims discipline

Every claim is qualified where it is made, with the same words the limitations files use: crossweave **hosts shells** in which you run agents (it never
runs, chooses or configures one); checkpoints need a session with its own worktree and a recognised agent, and turn boundaries are inferred; automatic test runs are
opt-in and off by default; "evidence-gated" landing is the default and `converge.requireCheck` is optional; the cockpit is macOS arm64 only; Linux has the CLI and the
TUI. A reviewer pass (Codex) reads the copy against the repository before it ships.

## Headline and voice

Recommended headline: **"Many agents. One repo. Land what holds up."** Subtitle: *crossweave runs each coding agent in its own git worktree and shell, shows you
which one is working, asking or done, and trial-merges them so you land the one that holds up.* Alternatives for the owner: *"The weft for your agents."* and
*"Run N agents on one repo without the merge-day panic."* Voice: first person plural is avoided; short sentences; no superlatives, no "revolutionary",
no unmeasured numbers; limits are stated next to the feature they limit.

## Visual design

- One token source: `src/theme.ts` imports the cockpit's `COCKPIT_TOKENS` (dark) and `LIGHT_COLORS` from `apps/cockpit/src/ui/themes.ts` (importing only the
  constants, never the functions that touch the DOM) and emits CSS
  variables, so the site and the app cannot drift. Dark is the default look (terminal-like surfaces, a restrained accent); light follows
  `prefers-color-scheme`; an explicit `data-theme` is not offered (no JavaScript).
- System font stack for text and a monospace stack for code; no web fonts. Generous spacing, a 1200 px measure, card grids that collapse to one column on a
  phone, visible focus rings, `prefers-reduced-motion` respected, no autoplay, no parallax.
- The app screenshots (`docs/images/*.png`) are of a made-up project and are already data-free.

## Images

The four screenshots are 2880×1800. They are resized once to 1600 px wide (PNG, `sips` on the owner's Mac) and committed under `website/public/img/`; the build
copies them and never needs an image tool, so CI on Linux stays dependency-free. Each `<img>` has `alt`, `width`, `height` and `loading="lazy"` (except the hero).
The Open Graph image is the hero screenshot. The originals stay in `docs/images`.

## Internationalisation

`en.ts` defines the content type; `vi.ts` must satisfy the same type, so a missing key fails typecheck. Pages exist at `/` and `/vi/`, each with
`<link rel="alternate" hreflang>` and a language switch in the header (a plain link to the same page in the other language). The Vietnamese text is written by
the assistant and needs the owner's proofreading before it is published; that is listed as a limitation, not hidden.

## Release data

The default source is a **committed manifest**, `website/release.json`: the newest tag, its date, the exact asset names and the checksum file name. A normal build
reads only that, so the same commit always builds the same bytes (a test builds twice offline and compares). The manifest is refreshed explicitly: `bun
website/build.ts --refresh-release` asks `https://api.github.com/repos/NMHx2005/crossweave/releases/latest` (unauthenticated, 5 s timeout), validates it (a
semantic-version tag, every asset name on an allow-list, every URL `https://github.com/NMHx2005/crossweave/…`), and rewrites the manifest; any failure leaves the
committed manifest untouched. The deploy workflow runs the refresh before building, so a published site follows the latest release; the committed manifest and
`docs/releases` use semantic-version ordering for "newest". If the manifest names a release whose assets are not on the release page the download links point at the
releases page instead of at an asset.

## Hosting

GitHub Pages through the official `actions/upload-pages-artifact` and `actions/deploy-pages` actions. The workflow (`pages.yml`) needs `permissions: contents: read,
pages: write, id-token: write`, `environment: github-pages`, a `concurrency` group, a pinned Bun (1.3.14), `actions/checkout`, and runs on pushes to `main` that touch
`website/**`, `docs/releases/**`, `docs/images/**`, `install.sh`, `README.md` or the cockpit token modules, on `workflow_dispatch`, and on **`workflow_run`** of the `release` workflow completing (a release published by an
action using `GITHUB_TOKEN` does not itself start another workflow, but the completion of the release workflow does).

One function, `url(path)`, builds every internal address (navigation, assets, canonical, Open Graph, hreflang, sitemap) from `SITE_URL` and `SITE_BASE`, which default
to `https://nmhx2005.github.io` and `/crossweave`. With `SITE_DOMAIN` set the base becomes `/`, a `CNAME` file is written, and `robots.txt` is emitted (a project
site's `robots.txt` is not read at the origin root, so it is only meaningful on a custom domain). `404.html` lives at the root of the artifact and uses only absolute,
base-aware resource paths. Writing `CNAME` does not configure DNS or the repository's Pages custom-domain setting; both stay the owner's one-time steps, as does
Settings → Pages → Source: GitHub Actions. The deploy always builds `main` (a release only triggers a rebuild with the new release data), installs the existing root dependencies, runs the website tests and builds with the
`base_path` and `origin` that `actions/configure-pages` reports. Nothing is pushed or deployed by the assistant.

## Motion (added 2026-10-11, after the owner's portfolio)

The page moves the way the owner's portfolio does, one expo-out curve for everything: the hero headline slides up word by word from behind a mask, the lines under it rise in
(fade, translate, a little blur) one after another, and the screenshot is uncovered from the top and settles in; sections, cards, table, questions and the closing block
settle into place as they enter the viewport (cards in a row left to right, the launcher chips one by one); an answer opens and closes smoothly; a thin bar under the top of
the window grows with the scroll; a page change cross-fades; cards and buttons lift a little on hover. Only opacity, translate, transform, filter and clip-path animate
(and the height of an answer), so there is no layout shift.

The rule that keeps the page honest, taken from the portfolio: **the content is visible by default**. The stylesheet may hide a block only under
`html[data-reveal-ready]`, which one small script (`reveal.js`, ~30 lines, no dependency) sets after it has marked what is already on screen as visible; no script, a script
that fails, or a browser without IntersectionObserver leaves nothing hidden. Everything moving is under `prefers-reduced-motion: no-preference`, reduced motion gets no animation or
transition, and printing shows everything. The hero entrance, the progress bar, the cross-fade and the hover effects need no script at all. This is the one change to the
original "no script" goal: the CSP gains `script-src 'self'` and nothing else.

## Security and privacy

- All text from outside the page's own source (a release tag, markdown) is escaped or rendered through the markdown renderer; release notes come from this
  repository only. A `<meta http-equiv="Content-Security-Policy">`, first in `<head>`, with `default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'`
  (GitHub Pages cannot send headers, and a meta policy cannot enforce `frame-ancestors`; both are stated in the limitations file); the only script is our own `reveal.js` (see Motion), loaded with `defer`, and there is no inline script, no inline
  event handler and no inline `style` attribute.
- No request leaves the visitor's browser except navigation to links they click.
- The page states the update check and the installer's network use exactly as the README does.

## Tests (`website/tests`, run by the root `bun test`)

- The build produces every expected file for both languages; every internal `href`/`src` resolves to a file in `dist`; no absolute URL is loaded as a
  resource (links to GitHub are fine, `src`/`href rel=stylesheet` to other origins are not).
- Each page has one `h1`, a `lang`, a `viewport` meta, a title of at most 60 characters, a description, an absolute canonical URL and absolute Open Graph URLs;
  `hreflang` pairs exist only for Home and Download (the pages that have a Vietnamese version) and are reciprocal; each `img` has `alt`, `width` and `height`; ids are
  unique; headings do not skip levels; authored tables have a `caption` and every table has `th scope`; the CSP meta is the first element of `<head>`.
- The English and Vietnamese content have the same keys (also a type error) and the same number of FAQ items, features and table rows.
- Docs: the four README headings exist and each docs page is non-empty; the changelog lists every `docs/releases/v*.md`, newest first.
- Release data: success, a failed fetch, a timeout, an asset missing, a malformed body — all produce a valid page; `NOTARIZED` true and false both render.
- Theme: the generated CSS has no literal colour outside `theme.ts`, and every text/background pair the stylesheet uses reaches WCAG AA in dark and light.
- Escaping and sanitising: a tag name such as `<img src=x>` in the manifest appears as text; a markdown fixture with a raw `<img onerror>`, a `<script>`, a
  `javascript:` link, a `data:` link, an off-site image and an attribute-breaking title renders with none of them live.
- Determinism: two offline builds from the same commit are byte-identical; the build with a failing, hanging or malformed `--refresh-release` leaves the manifest as it was.
- Link rewriting: README repository links become GitHub URLs; a fragment with no target fails the build.
- Install facts: a test reads `install.sh` and `release.yml` and checks that every asset name the Download page shows is one the workflow publishes.
- Visual (by hand, recorded in the limitations file): screenshots of every page at desktop and phone width, in both colour schemes, read by a person.

## Limitations to record

- No notarization: a DMG downloaded in a browser triggers Gatekeeper; the installer path avoids it.
- Docs and the changelog are English only; the Vietnamese pages link to them. The Vietnamese copy needs the owner's proofreading.
- The release data is read at build time, so a page can show the previous version until the next deploy; `release: published` triggers one.
- No video or demo recording yet; the comparison is with doing it by hand, not with named products; no custom domain; GitHub Pages serves the site and cannot set
  response headers, so the CSP is a `<meta>` tag.
- Light/dark follows the system; there is no toggle.
- `Bun.markdown` is an unstable API: it is pinned and guarded by a golden test, and the renderer is ours.
- The page cannot set response headers (no `frame-ancestors`, no HSTS of its own), and a project site's `robots.txt` is not honoured at the origin root.
- `install.sh` still prints a warning about bubblewrap that no longer applies (the OS sandbox was removed on 2026-09-27); fixed as a separate small change in the plan.

## Open choices for the owner

The headline above (or one of the two alternatives); the repository's GitHub URL stays `NMHx2005/crossweave`; a custom domain later.
