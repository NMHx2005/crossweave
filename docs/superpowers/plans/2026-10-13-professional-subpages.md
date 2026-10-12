# Professional bilingual subpages implementation plan

> Execute task by task with TDD. Keep the homepage unchanged and do not deploy.

**Goal:** Make Download, Docs and Changelog feel like a coherent, polished developer portal in English and Vietnamese.

**Architecture:** Extend the existing typed bilingual content and static page renderers. Derive documentation contents navigation from renderer heading metadata; derive changelog jump links from the already sorted release notes and stable release IDs. Use current cockpit-derived design tokens and CSS only.

**Tech stack:** Bun, TypeScript, static HTML, CSS, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-13-professional-subpages-design.md`

## Constraints

- Keep the existing static Bun site build and add no dependency.
- Do not modify the homepage's approved visual treatment.
- Keep EN/VI routes, canonical URLs, alternates, release asset links, install commands and stable release section IDs intact.
- Preserve the notarization, missing-asset fallback and checksum behaviors.
- Run focused tests red then green for each renderer; run required repository gates sequentially with test concurrency set to 1.
- Work only on `codex/website-full-i18n`; do not deploy or push.

### Task 1: Reshape Download for release selection

**Files:** `website/src/pages/download.ts`, `website/src/content/types.ts`, `website/src/content/en.ts`, `website/src/content/vi.ts`, `website/src/styles.css`, `website/tests/pages.test.ts`, `website/tests/theme.test.ts` if token coverage requires it.

- [ ] Test EN/VI render structure: release header/tag, recommended Cockpit action, distinct CLI install panel and localized labels.
- [ ] Run the focused page tests and confirm the new structure assertions fail.
- [ ] Implement semantic sections and typed localized labels; group platform binaries, checksums and older-release fallback while retaining existing destinations and notices.
- [ ] Add responsive token-based styles for the release header, download cards and compact asset list.
- [ ] Run focused tests and inspect changed CSS for theme-token compliance.

### Task 2: Add generated on-page Docs navigation

**Files:** `website/src/pages/docs.ts`, `website/src/content/types.ts`, `website/src/content/en.ts`, `website/src/content/vi.ts`, `website/src/styles.css`, `website/tests/docs.test.ts`, `website/tests/build.test.ts`.

- [ ] Test that both locales render a localized contents nav whose links exactly target article heading IDs, including a page with no headings.
- [ ] Run docs tests and confirm the new contents assertions fail.
- [ ] Generate contents links from `rendered.headings`; include a localized accessible label and skip the nav when no headings exist.
- [ ] Add a desktop three-column layout and responsive collapse using existing tokens; preserve active section navigation.
- [ ] Run focused tests and check for unresolved internal fragments.

### Task 3: Make Changelog navigable by release

**Files:** `website/src/pages/changelog.ts`, `website/src/content/types.ts`, `website/src/content/en.ts`, `website/src/content/vi.ts`, `website/src/styles.css`, `website/tests/pages.test.ts`, `website/tests/build.test.ts`.

- [ ] Test both locales for a localized release-index label and links targeting all sorted release section IDs.
- [ ] Run focused tests and confirm the new index assertions fail.
- [ ] Render an accessible release index from the same sorted notes as the timeline; preserve tag-derived IDs, date and unreleased semantics.
- [ ] Add desktop sticky index and mobile wrapping styles, using theme tokens.
- [ ] Run focused tests for anchor parity and rendered release content.

### Task 4: Verify, document and commit

**Files:** `docs/superpowers/specs/2026-10-13-professional-subpages-known-limitations.md`, `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`.

- [ ] Record remaining limits, including absent search/versioned docs and need for independent Vietnamese proofreading.
- [ ] Run `bun run typecheck`, `bun test --max-concurrency=1`, and `bun run build` sequentially; capture each result.
- [ ] Build website output with `SITE_DOMAIN=crossweave.dev bun website/build.ts --out /tmp/crossweave-i18n-build`; inspect EN/VI Download, Docs and Changelog routes and anchors.
- [ ] Check `git diff --check`, review the diff and verify no homepage regression or generated output is included.
- [ ] Commit the design/plan and implementation as focused Conventional Commits on the feature branch. Do not push or deploy.
