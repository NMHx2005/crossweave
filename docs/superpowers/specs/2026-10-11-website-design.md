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

A Bun script (`website/build.ts`) renders static HTML from typed content modules (English and Vietnamese) and from markdown that already lives in the repository
(`Bun.markdown.html` is built in, so no markdown library is needed). Rejected: Astro (a large dependency tree with native pieces such as sharp and esbuild for a
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

## Pages (each in English at `/…` and Vietnamese at `/vi/…`)

1. **Home**
   - **Hero:** the headline, a one-line subtitle, two buttons — *Download for macOS* and *Install the CLI* (the `curl … | sh` line, with a copy-free plain
     `<code>` block: no JavaScript) — a GitHub link, the version and licence, and the main screenshot.
   - **"Your dev loop"** grid of feature cards, each one sentence and one link to its limitations file or docs section: sessions as worktree + shell; one
     rail that says who is working, asking or done; checkpoints around every agent turn; diff comments pasted into the shell; automatic test runs and a failed-test
     alert; sensitive-file flags before landing; trial merges and evidence-gated landing; compare two sessions; prompt composer to many sessions; debug pane;
     browser agent (Off/Read/Control); presets.
   - **Works with the agents you already run:** the launcher names as plain text (Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, Copilot CLI, Aider,
     Amp, Qwen Code, or your own wrapper), plus the sentence that crossweave never chooses, configures or launches one for you. No logos.
   - **What it deliberately does not do:** no agent model, no remote control in a browser, no in-app dictation, no collision guard or sandbox, no Windows, and what
     each removal was (with its last tag).
   - **Comparison:** two columns, *By hand (git worktree + tmux)* and *crossweave*, on rows that can be checked (one branch per agent, port/cache/DB names per
     session, what is ready to land and in which order, what the agent just changed, a record of each turn). Third-party products are not named.
   - **FAQ** (native `<details>`): what it is and is not, is it an IDE, which agents, does it choose the agent, where does my code go (nowhere: local daemon, one
     unix socket; the only network use is the optional update check against GitHub and the install download), telemetry (none), platforms, cost and licence, why it
     is not notarized, how to update (`cw update`), what auto-check runs, how checkpoints work, how to uninstall.
   - **Why "crossweave":** the warp and weft paragraph from the README.
   - **Closing call to action** and the footer: Download, Changelog, Docs, GitHub, Issues, MIT licence, version.
2. **Download:** the Cockpit `.dmg` and `.zip` (macOS arm64), the CLI binaries per platform (macOS arm64/x64, Linux x64) and `checksums.txt`, all linking to the
   latest GitHub release; the installer line; requirements (macOS or Linux, git, Bun is *not* needed for the compiled binaries — verified against `install.sh`
   in the plan); and an honest **"Not notarized yet"** box: why macOS shows a warning for a browser download, that the installer does not trigger it (files
   fetched with `curl` are not quarantined), and the one command to clear the flag for a downloaded app. A `NOTARIZED` constant in `src/release.ts` swaps this box for
   a plain line when it becomes true.
3. **Docs:** an index and pages built from the README by heading (**Install**, **Quickstart**, **Cockpit (desktop)**, **Configuration**): the build fails if one of
   those headings disappears, so the docs cannot silently go stale. A short "Concepts" page (session, worktree, rail, land, evidence) written for the site, and a
   `cw` command list taken from `cw --help` output captured in a test fixture. Docs stay in English in v1 (translating the README is out of scope; the Vietnamese
   pages say so and link to the English ones).
4. **Changelog:** every `docs/releases/v*.md`, newest first, rendered from markdown, English only.
5. **404**, `sitemap.xml`, `robots.txt`, a web manifest-free `<link rel="icon">` from the app icon.

## Headline and voice

Recommended headline: **"Many agents. One repo. Land what holds up."** Subtitle: *crossweave runs each coding agent in its own git worktree and shell, shows you
which one is working, asking or done, and trial-merges them so you land the one that holds up.* Alternatives for the owner: *"The weft for your agents."* and
*"Run N agents on one repo without the merge-day panic."* Voice: first person plural is avoided; short sentences; no superlatives, no "revolutionary",
no unmeasured numbers; limits are stated next to the feature they limit.

## Visual design

- One token source: `src/theme.ts` imports the cockpit's `COCKPIT_TOKENS` (dark) and the light theme from `apps/cockpit/src/ui/themes.ts` and emits CSS
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

`src/release.ts` asks `https://api.github.com/repos/NMHx2005/crossweave/releases/latest` at build time (unauthenticated, 5 s timeout). On any failure, or when
the release has no asset of a given name, it falls back to the constants for the newest tag in `docs/releases` and links to the releases page instead of
a direct asset. The build never fails because GitHub is unreachable, and tests inject the fetcher. `pages.yml` rebuilds on pushes to `main` that touch
`website/**`, `docs/releases/**` or `README.md`, and on `release: published`, so the version and links follow each release.

## Hosting

GitHub Pages through the official `actions/upload-pages-artifact` and `actions/deploy-pages` actions. `SITE_URL` and `SITE_BASE` (default
`https://nmhx2005.github.io` and `/crossweave`) are build variables; a `SITE_DOMAIN` writes a `CNAME` file. The owner enables Settings → Pages → Source:
GitHub Actions once. Nothing is pushed or deployed by the assistant.

## Security and privacy

- All text from outside the page's own source (a release tag, markdown) is escaped or rendered through the markdown renderer; release notes come from this
  repository only. A `<meta http-equiv="Content-Security-Policy">` allows `'self'` for everything and `data:` for images; there are no inline scripts and no
  inline event handlers, and inline `style` attributes are not used.
- No request leaves the visitor's browser except navigation to links they click.
- The page states the update check and the installer's network use exactly as the README does.

## Tests (`website/tests`, run by the root `bun test`)

- The build produces every expected file for both languages; every internal `href`/`src` resolves to a file in `dist`; no absolute URL is loaded as a
  resource (links to GitHub are fine, `src`/`href rel=stylesheet` to other origins are not).
- Each page has one `h1`, a `lang`, a title of at most 60 characters, a description, a canonical URL and hreflang pairs; each `img` has `alt`, `width` and
  `height`; ids are unique; headings do not skip levels.
- The English and Vietnamese content have the same keys (also a type error) and the same number of FAQ items, features and table rows.
- Docs: the four README headings exist and each docs page is non-empty; the changelog lists every `docs/releases/v*.md`, newest first.
- Release data: success, a failed fetch, a timeout, an asset missing, a malformed body — all produce a valid page; `NOTARIZED` true and false both render.
- Theme: the generated CSS has no literal colour outside `theme.ts`, and every text/background pair the stylesheet uses reaches WCAG AA in dark and light.
- Escaping: a tag name such as `<img src=x>` in the release data appears as text.
- Visual (by hand, recorded in the limitations file): screenshots of every page at desktop and phone width, in both colour schemes, read by a person.

## Limitations to record

- No notarization: a DMG downloaded in a browser triggers Gatekeeper; the installer path avoids it.
- Docs and the changelog are English only; the Vietnamese pages link to them. The Vietnamese copy needs the owner's proofreading.
- The release data is read at build time, so a page can show the previous version until the next deploy; `release: published` triggers one.
- No video or demo recording yet; the comparison is with doing it by hand, not with named products; no custom domain; GitHub Pages serves the site and cannot set
  response headers, so the CSP is a `<meta>` tag.
- Light/dark follows the system; there is no toggle.

## Open choices for the owner

The headline above (or one of the two alternatives); the repository's GitHub URL stays `NMHx2005/crossweave`; a custom domain later.
