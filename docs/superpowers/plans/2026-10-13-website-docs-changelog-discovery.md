# Docs search, release snapshots and Changelog controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Crossweave's static Docs searchable and browsable at released README snapshots, and make the bilingual Changelog searchable, filterable and paginated.

**Architecture:** The Bun site build reads each published release tag's README using argument-safe `git show`, renders an English archive page and emits per-language static Docs search indexes with content-addressed URLs. The current Docs and archive content remain complete HTML; `site.js` enhances search and Changelog filters, URL state, and paging without a server or third-party runtime. Changelog release sections carry normalized category and searchable-text metadata so the browser can filter complete static release sections.

**Tech Stack:** Bun ≥ 1.3.13, TypeScript, `bun:sqlite` unused, dependency-free static HTML/CSS/SVG/JavaScript, `bun test`, GitHub Pages.

**Specs:**
- `docs/superpowers/specs/2026-10-13-website-docs-search-versioning-design.md`
- `docs/superpowers/specs/2026-10-13-website-changelog-controls-design.md`

## Global Constraints

- Keep the public website dependency-free and static; add no runtime, server endpoint, framework, native module or external search service.
- Fetch released Git tags in the Pages workflow; pass tag and path as separate `git` arguments, never shell-interpolated text.
- Preserve complete Docs and Changelog HTML when JavaScript is unavailable; controls only become visible after successful initialization.
- Provide English and Vietnamese labels, names, empty/error messages, result counts and pagination controls.
- Use semantic native controls, keyboard operation, visible labels and polite live status; preserve existing canonical URLs, language alternates, release anchors, CSP intent and cache fingerprinting.
- Tests pin public behavior; run gates sequentially with `bun test --max-concurrency=1`.
- The current worktree is isolated on `codex/docs-search-version-snapshots`; do not commit directly to `main`.

---

### Task 1: Load and render exact published README snapshots

**Files:**
- Create `website/src/version-snapshots.ts` for safe Git tag reads and archive-page rendering.
- Modify `website/src/types.ts` (`BuildOptions`) and `website/build.ts` to inject or load tag README inputs and add archive pages.
- Modify `.github/workflows/pages.yml` to fetch tag history (`fetch-depth: 0`).
- Test `website/tests/version-snapshots.test.ts`, `website/tests/build.test.ts`, and `website/tests/pages.test.ts`.

**Interfaces:**
- `VersionSnapshot`: `{ tag: string; readme: string }`.
- `BuildOptions.snapshots?: readonly VersionSnapshot[]` is a deterministic fixture seam. Production discovers release tags from the validated bilingual release-note parity set and reads each `<tag>:README.md` with `execFileSync('git', ['show', ref], { cwd: repoRoot, encoding: 'utf8' })`.
- `versionedDocsPages({ urls, snapshots }): BuiltPage[]` emits `/docs/versions/<tag>/` English snapshot pages from the same `renderMarkdown` safety allow-list. Relative repository links resolve to that tag's GitHub tree; same-page heading fragments remain local and are checked against rendered heading IDs. Pages use `lang: 'en'`, canonical self URLs, and no false Vietnamese `hreflang` counterpart.

- [ ] **Step 1: Write failing snapshot-source tests.** In `website/tests/version-snapshots.test.ts`, assert that an injected `v0.6.0` README becomes one archive page with the exact route, source-tag notice, heading IDs, local heading link and tag-pinned relative GitHub links. Add tests rejecting malformed/non-release tags and dead local fragments.
- [ ] **Step 2: Run `bun test website/tests/version-snapshots.test.ts` and confirm it fails** because the module/renderer does not exist.
- [ ] **Step 3: Implement the pure archive renderer and safe source reader.** Use `execFileSync` with `['show', `${tag}:README.md`]`; validate tags against `^v\d+\.\d+\.\d+$`; never invoke a shell. Render Markdown with the existing renderer and retain its raw-HTML rejection and unique heading IDs.
- [ ] **Step 4: Run the snapshot tests and require them to pass.** Add a regression where a bad tag or missing README fails the build with the release tag named in the error.
- [ ] **Step 5: Add build integration tests first.** Inject two snapshots into `build()` and assert both archive HTML files and sitemap entries exist; verify base-path and custom-domain routes. Confirm the test fails before wiring `build.ts`.
- [ ] **Step 6: Wire production snapshot discovery and Pages checkout depth.** Derive allowed release tags from the already parity-checked `notesByLang.en`; fail closed if any release-tag README is missing. Set checkout `fetch-depth: 0` only on the Pages workflow.
- [ ] **Step 7: Run `bun test website/tests/version-snapshots.test.ts website/tests/build.test.ts website/tests/pages.test.ts`.** Verify no network or local-tag dependency exists in injected test builds.

### Task 2: Generate and use static Docs search indexes

**Files:**
- Create `website/src/docs-search.ts` for normalized index entries and deterministic query matching.
- Modify `website/src/pages/docs.ts`, `website/build.ts`, `website/src/layout.ts`, `website/src/content/types.ts`, `website/src/content/en.ts`, `website/src/content/vi.ts`, `website/src/styles.css`, and `website/public/site.js`.
- Test `website/tests/docs-search.test.ts`, `website/tests/docs.test.ts`, `website/tests/build.test.ts`, `website/tests/layout.test.ts`, and `website/tests/site-script.test.ts`.

**Interfaces:**
- `DocsSearchEntry`: `{ version: string; title: string; section: string; href: string; text: string; lang: Lang }`.
- `buildDocsSearchIndex(entries): string` emits escaped JSON in deterministic order. Build creates one index per UI language from the corresponding current Docs pages plus English archive pages; historical entries keep `lang: 'en'` and display an explicit English-source label in Vietnamese results.
- `searchDocs(entries, query, version, limit)` returns entries whose normalized title/section/body contain every normalized query term, with the chosen source scope and a fixed result cap.
- The Docs overview includes a `<form data-docs-search>` with a same-origin `data-search-index` URL containing the SHA-256 fingerprint of the exact emitted JSON. The existing CSP adds only `connect-src 'self'` for this fetch.

- [ ] **Step 1: Write failing pure search tests.** Cover Unicode/case folding, all-term matching across title/body, selected version, all-version scope, stable ordering, zero results and result cap.
- [ ] **Step 2: Run `bun test website/tests/docs-search.test.ts` and confirm the expected missing-module failures.**
- [ ] **Step 3: Implement pure normalization and matching.** Normalize query and indexed text consistently; do not use dynamic regular expressions from user input or `innerHTML` to display excerpts.
- [ ] **Step 4: Run search tests to green.** Add cases for empty/whitespace queries and accented Vietnamese text.
- [ ] **Step 5: Write failing page/index tests.** Assert that EN and VI overview controls have localized labels, source selector and hint about English archives; generated index entries link to existing page/heading IDs and identify snapshot versions. Assert index URLs hash the exact JSON emitted.
- [ ] **Step 6: Generate index entries from the same typed Docs pages as HTML.** Extract headings and visible article text without including shell navigation/footer, preserve source-language/version metadata, serialize and write `docs-search.en.json` and `docs-search.vi.json` during build.
- [ ] **Step 7: Add fail-safe client behavior tests.** Extend the `site.js` test harness for an async same-origin index response: matching results update the live region; empty results are localized; a fetch rejection displays an error and leaves article text visible; query/version state is restored from and written to the URL.
- [ ] **Step 8: Add localized search strings and overview form markup.** Controls stay `hidden` until the index loads; selected release links remain usable if JavaScript is absent.
- [ ] **Step 9: Implement `docsSearch()` in `site.js`.** Fetch the fingerprinted JSON only after initialization, build result anchors with DOM methods and `textContent`, set query parameters through `URL`/`history`, support `popstate`, and mark historical English results clearly on the VI page.
- [ ] **Step 10: Extend CSP narrowly and style search.** Add `connect-src 'self'`; use existing tokens, mobile spacing and visible `:focus-visible` styles. Add tests that no inline executable script or untrusted HTML is introduced.
- [ ] **Step 11: Run Docs, layout, build and site-script tests; verify the `main` Docs body remains readable without JavaScript.**

### Task 3: Add Changelog filters and release-level pagination

**Files:**
- Create `website/src/changelog-controls.ts` for normalized category keys and pure filtering/pagination.
- Modify `website/src/pages/changelog.ts`, `website/src/content/types.ts`, `website/src/content/en.ts`, `website/src/content/vi.ts`, `website/src/styles.css`, and `website/public/site.js`.
- Test new `website/tests/changelog-controls.test.ts`, plus `website/tests/pages.test.ts`, `website/tests/build.test.ts`, and `website/tests/site-script.test.ts`.

**Interfaces:**
- `ChangeCategory` keys: `new`, `fixed`, `removed`, `upgrading`, `known-limits`; treat `Headline` as introductory prose, not a category.
- `ReleaseEntry`: `{ tag: string; categories: ChangeCategory[]; searchText: string; href: string }`.
- `filterReleases(entries, { query, version, category })` preserves descending semantic-version order and matches all query terms.
- `paginateReleases(entries, page, pageSize = 3)` clamps to at least page 1 and returns `{ entries, page, pageCount, total }`.
- Changelog sections receive escaped `data-version`, `data-categories` and normalized `data-search` values. No rendered release HTML is removed from the DOM.

- [ ] **Step 1: Write failing category/filter/pagination tests.** Cover English headings with suffixes (`New — ...`, `Fixed — ...`), Vietnamese equivalents (`Mới`, `Đã sửa`, `Đã loại bỏ`, `Nâng cấp`, `Giới hạn đã biết`), combined filters, stable ordering, zero results, 4 releases over 2 pages, empty list and page clamping.
- [ ] **Step 2: Run `bun test website/tests/changelog-controls.test.ts` and confirm missing-module failure.**
- [ ] **Step 3: Implement category normalization, query matching and pagination.** Do not mutate source release ordering.
- [ ] **Step 4: Run the utility test file to green.**
- [ ] **Step 5: Add failing rendering tests.** Require localized labeled controls, normalized release metadata, stable original section IDs, and every release body still present when controls are hidden.
- [ ] **Step 6: Implement release metadata and localized markup.** Render categories from top-level Markdown section headings, ignore `Headline`, keep the existing release index, and add an explicit no-match result region.
- [ ] **Step 7: Add `changelogExplorer()` event tests.** Verify version/category/query combinations, 3-item paging, filter changes reset page to 1, URL history/back-forward restore, a deep-linked `#v0-6-0` activates the containing page, and all sections/index links remain visible when JS does not initialize.
- [ ] **Step 8: Implement the progressive client interaction.** Keep controls hidden until parsing succeeds; make the status region polite; use native controls and DOM attributes; never use `innerHTML` for filter results.
- [ ] **Step 9: Add token-based responsive CSS and bilingual labels.** Page controls wrap on narrow screens and have visible keyboard focus; all filter labels and empty/count/pagination text have EN and VI copy.
- [ ] **Step 10: Run changelog, site-script and build tests.** Confirm both localized pages have distinct query state and at least one next/previous state across the current four releases.

### Task 4: Run project gates, browser review and record remaining limits

**Files:**
- Update `docs/superpowers/specs/2026-08-14-known-limitations-digest.md` and add `docs/superpowers/specs/2026-10-13-website-docs-discovery-known-limitations.md`.
- Update `docs/PROGRESS.md` and `docs/HANDOFF-2026-10-13.md` with verified outcomes and feature limits.
- Mark this plan complete only after all applicable checks and deployment evidence are available.

- [ ] **Step 1: Run `bun run typecheck`.**
- [ ] **Step 2: Run `bun test --max-concurrency=1`.** Record the complete pass/fail total.
- [ ] **Step 3: Run `SITE_DOMAIN=crossweave.dev bun website/build.ts --out /tmp/crossweave-doc-discovery-preview`.** Check the generated archive pages, search index digests, canonical/hreflang metadata, sitemap, EN/VI search routes and Changelog controls.
- [ ] **Step 4: Review live local preview in Chromium at desktop and 390px widths.** Search exact page title and partial body, select an older release, follow a result; filter Changelog by version/category/text, move to next page, use back/forward, and follow a release anchor. Verify keyboard-only operation, no document overflow, all content available without JavaScript and browser console has no errors.
- [ ] **Step 5: Run `git diff --check`; review scope, tests, content, CSP, absence of new packages/native modules, and `git status`.** Do not run `bun run build` for CLI binaries because no `src/` files are touched; the website build and CI website gates cover this change.
- [ ] **Step 6: Write the dated known-limitations record and digest entry.** Distinguish limitations (historical snapshots are English, search is local/client-side) from unshipped features.
- [ ] **Step 7: Commit each independently testable milestone with a Conventional Commit.** Keep `main` linear and use fast-forward only after the gates pass. Deploy only after the user's existing deployment authorization is applied to this feature.
