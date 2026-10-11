# Website post-launch quality — design

## Problem

The site is live and its source builds a static bilingual website. The live sitemap currently lists `http://crossweave.dev/...` URLs even though page canonicals use HTTPS. The Pages workflow supplies `SITE_URL` from `configure-pages`'s `origin`; local tests already cover custom-domain output but do not catch this deployed configuration. The demo video's markup has `autoplay` and no native controls; the custom pause/play control appears only after JavaScript starts. The reduced-motion handler pauses after script execution, which can allow an initial frame of motion, while a reader without JavaScript has no pause control. The Vietnamese copy and several browser/display cases have not had a human proofread or manual pass.

## Goal and boundaries

Fix the deployed sitemap's origin, make the hero clip usable without JavaScript and respectful of reduced-motion preferences from its first frame, proofread Vietnamese content, and complete a bounded browser quality pass. Do not add website features such as search, RSS, theme switching, `llms.txt` or per-feature pages in this milestone.

## Design

Use the site's canonical custom-domain configuration (`SITE_DOMAIN=crossweave.dev`, which builds HTTPS root URLs) for the Pages production artifact, or an equivalent explicit HTTPS origin that preserves the intended root base. Add build-level assertions that every sitemap URL, canonical URL and robots sitemap reference use the production HTTPS origin and that no `http://crossweave.dev` URL is emitted. Keep GitHub Pages project-base behavior covered in its existing build test.

For the video, start from a static poster with browser controls available. Remove declarative autoplay. Once `site.js` has initialized the custom control, it may hide native controls and start playback only when the system allows motion. With reduced motion, do not autoplay at all; allow an explicit Play action. If JavaScript fails or is disabled, leave native controls available. Keep the existing reduced-motion behavior for other animations and do not depend on JavaScript to reveal content.

Have the owner or a Vietnamese-fluent reviewer proofread `website/src/content/vi.ts` against English source and the established glossary. Preserve English command names, git terms and technical qualifiers; content tests must continue to enforce key parity and reject placeholders. The manual pass covers English and Vietnamese home/download pages, English docs/changelog/security, dark and light schemes, keyboard focus, mobile widths, 200% zoom, reduced motion, video playback and no-JavaScript fallback. Record browser/OS and outcomes; fix only defects found in scope.

## Acceptance

- The next deployed sitemap lists HTTPS URLs on `crossweave.dev`; canonicals, hreflang and `robots.txt` point to the same production origin. Project Pages builds still use their expected origin and base path.
- The page has no autoplay attribute. With script unavailable the poster and native controls work. With reduced motion the video does not play until the person asks. With normal motion and initialized script, the custom accessible control works.
- Vietnamese strings have been reviewed by a fluent reader and corrected; language parity/type/content tests pass.
- Manual results record viewport, scheme, motion preference, keyboard behavior, video result and browser for the tested routes. Any untested browser is called out as unfinished, not passed.
- Website tests pass, root typecheck passes if shared types change, and the Pages workflow succeeds after deployment.
- Browser/accessibility findings not fixed in scope go into a dated known-limitations file and the digest.

## Relevant files

- `.github/workflows/pages.yml` — production build environment and Pages deployment.
- `website/src/site.ts` — canonical origin/domain normalization.
- `website/build.ts` — sitemap and robots generation.
- `website/tests/build.test.ts`, `website/tests/site.test.ts` — base path, origin and generated sitemap contracts.
- `website/src/pages/home.ts`, `website/public/site.js` — video markup and control behavior.
- `website/tests/pages.test.ts`, `website/tests/site-script.test.ts`, `website/tests/motion.test.ts` — static and script contracts.
- `website/src/content/vi.ts`, `website/tests/content.test.ts` — translated content.
- `website/src/styles.css` and cockpit token modules — responsive, focus, motion and color presentation.
- `docs/PROGRESS.md`, `docs/HANDOFF-2026-10-11.md`, dated known-limitations and digest — current project state and remaining gaps.
