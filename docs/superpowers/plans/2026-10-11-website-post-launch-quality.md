# Website Post-Launch Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and complete each task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the production sitemap, make the demo video accessible without JavaScript and with reduced motion, proofread Vietnamese copy, and complete the outstanding browser review.

**Architecture:** Keep the static Bun build and same-origin assets. Set the production build to the HTTPS custom domain, retain project Pages base-path support, and make script enhancement progressive: native video controls are the no-script baseline and custom playback is enabled only after initialization.

**Tech Stack:** Bun, TypeScript, static HTML/CSS/JavaScript, GitHub Pages, existing Bun website tests, manual Safari/Firefox/Chromium checks.

**Spec:** `docs/superpowers/specs/2026-10-11-website-post-launch-quality-design.md`

## Global Constraints

- Keep the website build dependency-free and deterministic; do not add a runtime dependency.
- Preserve the allow-listed Markdown renderer, same-origin CSP and existing route/base-path behavior.
- Preserve bilingual key parity and the repository glossary; commands and established git terms remain unchanged.
- Respect `prefers-reduced-motion` from initial HTML behavior; user-initiated playback remains available.
- Do not claim a browser/device check passed unless it was run and recorded.
- Write newly discovered gaps to a dated known-limitations file and one line in the digest.
- Keep gates sequential: `bun test website/tests --max-concurrency=1`; run root typecheck only if shared TS contracts changed; run the Pages workflow after publishing.

---

### Task 1: Make the production sitemap consistently HTTPS

**Files:**
- Modify: `.github/workflows/pages.yml`
- Modify if needed: `website/src/site.ts`
- Test: `website/tests/build.test.ts`, `website/tests/site.test.ts`

- [x] **Step 1: Add a failing custom-domain build assertion**

Build with `SITE_DOMAIN=crossweave.dev`; assert all `<loc>` URLs, the home canonical URL, `hreflang` alternates and `robots.txt` sitemap URL begin with `https://crossweave.dev/`. Assert the sitemap has no `http://crossweave.dev/` entry.

- [x] **Step 2: Keep the GitHub project-site regression covered**

Retain assertions for the default `https://nmhx2005.github.io/crossweave/` origin and base path. The custom-domain fix must not change a project-site build.

- [x] **Step 3: Set the Pages workflow's production domain explicitly**

Pass `SITE_DOMAIN=crossweave.dev` to `bun website/build.ts --refresh-release` in `.github/workflows/pages.yml`. Keep `SITE_BASE` behavior for the non-custom-domain configuration only if the workflow still needs to deploy a project-site preview; for the configured production domain, `SITE_DOMAIN` takes precedence and emits root paths.

- [x] **Step 4: Run the website build tests**

Run: `bun test website/tests/build.test.ts website/tests/site.test.ts --max-concurrency=1`

Expected: both custom-domain HTTPS assertions and project-site base assertions pass.

- [x] **Step 5: Verify the generated artifact**

Run: `SITE_DOMAIN=crossweave.dev bun website/build.ts` and inspect `website/dist/sitemap.xml`, `website/dist/robots.txt`, and `website/dist/index.html`.

Expected: all absolute URLs use HTTPS and the custom domain, with no project base path.

### Task 2: Make video playback progressive and reduced-motion safe

**Files:**
- Modify: `website/src/pages/home.ts`
- Modify: `website/public/site.js`
- Modify: `website/tests/pages.test.ts`
- Modify: `website/tests/site-script.test.ts`
- Modify: `website/tests/motion.test.ts`

- [x] **Step 1: Add failing static-markup tests**

Assert the video has a poster and native `controls`, has no declarative `autoplay`, and the custom control starts hidden until initialized. Keep its accessible label and dimensions.

- [x] **Step 2: Add failing script tests for normal motion**

Assert initialized JavaScript hides native controls only after the custom toggle is wired, starts playback when motion is allowed, pauses when asked, and restores a usable Play action after the video leaves the viewport.

- [x] **Step 3: Add failing tests for reduced motion and missing script support**

Assert reduced motion never calls `play()` during initialization and explicit Play can start playback. If `matchMedia`, the video API, or the custom control cannot initialize, preserve native controls and do not autoplay.

- [x] **Step 4: Update markup and script**

Remove the HTML `autoplay` attribute and include `controls`. Make `site.js` opt into autoplay only after successful setup and only when the preference is `no-preference`; otherwise leave a static poster and usable controls. Switch from native to custom controls only after the custom event handler is installed.

- [x] **Step 5: Run focused tests**

Run: `bun test website/tests/pages.test.ts website/tests/site-script.test.ts website/tests/motion.test.ts --max-concurrency=1`

Expected: existing motion behavior and all new fallback/reduced-motion cases pass.

### Task 3: Proofread Vietnamese content

**Files:**
- Review and modify if needed: `website/src/content/vi.ts`
- Read: `website/src/content/en.ts`, `website/src/content/types.ts`
- Test: `website/tests/content.test.ts`

- [x] **Step 1: Compare every visible Vietnamese string with its English counterpart**

Review home, navigation, download, FAQ, video labels/transcript, footer and recent-release copy. Preserve `worktree`, `session`, `rail`, `land`, command names, paths and established glossary choices.

- [x] **Step 2: Correct only translation and clarity issues**

Keep product claims and qualifiers equivalent to English. Do not add unsupported claims or translate commands and filenames.

- [ ] **Step 3: Ask a Vietnamese-fluent reviewer to proofread**

Give the reviewer the generated Vietnamese home and download pages plus English source copy. Incorporate their concrete corrections before calling this complete.

- [x] **Step 4: Run bilingual content tests**

Run: `bun test website/tests/content.test.ts --max-concurrency=1`

Expected: required keys and feature counts match, content is valid, and no placeholder copy is introduced.

### Task 4: Complete and record the browser quality pass

**Files:**
- Fix in-scope issues found in: `website/src/styles.css`, `website/src/layout.ts`, `website/src/pages/*.ts`, `website/public/site.js`, `website/src/content/vi.ts`
- Update: `docs/superpowers/specs/2026-10-11-website-v2-known-limitations.md`
- Update: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`

- [x] **Step 1: Build and serve the production-shaped site locally**

Run `SITE_DOMAIN=crossweave.dev bun website/build.ts`, then serve the generated site at an explicitly chosen port. Confirm the running process is stopped after the review.

- [x] **Step 2: Check core routes at phone and desktop sizes**

Review `/`, `/vi/`, `/download/`, `/vi/download/`, `/docs/`, `/changelog/` and `/docs/security/` at 320 px, 375 px, 768 px and 1280 px widths, including 200% text zoom. Check for horizontal overflow, obscured header content, clipped video controls and broken navigation.

- [x] **Step 3: Check keyboard, color schemes and motion**

Use keyboard only to reach every navigation item, video control, copy button and disclosure; verify visible focus and sensible skip-link behavior. Check dark and light schemes. With reduced motion enabled, confirm no automatic video playback or reveal animation.

- [ ] **Step 4: Check playback and fallback in the full browser matrix** — Chromium baseline passes. Safari's live normal-motion autoplay and Pause/Play pass a manual smoke check; Safari reduced-motion, off-screen and no-JavaScript behavior were not repeated manually. Firefox is unavailable and remains untested.

Test current Safari and Firefox when available, plus Chromium for baseline; test muted autoplay under normal motion, explicit Play under reduced motion, Pause, off-screen pause, and JavaScript-disabled native controls. Record browser and OS versions. Mark unavailable browsers as untested.

- [x] **Step 5: Run the full website test suite**

Run: `bun test website/tests --max-concurrency=1`

Expected: pass.

- [ ] **Step 6: Deploy and verify the live site**

After the approved change reaches `main`, wait for the Pages workflow. Fetch the live sitemap and confirm HTTPS URLs, check the hero's live markup and run the manual checks that were blocked locally.

- [x] **Step 7: Close or document remaining gaps**

Remove completed website limitations, keep untested browser cases listed as unfinished, and add new findings to the dated website limitation file and digest. Do not add Docs search, RSS, a theme toggle, `llms.txt`, translated docs or feature pages in this milestone.

**Still pending:** independent Vietnamese human proofread and the full Safari/Firefox playback matrix. Pages deployment and live HTTPS metadata are verified. Chromium keyboard/playback checks are complete; Safari has a partial manual smoke check; Firefox remains unavailable and untested.

**Commit:** `fix(website): use HTTPS sitemap and accessible video fallback`
