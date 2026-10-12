# Full bilingual website design

## Problem

Only the homepage and download page currently have English/Vietnamese pairs. The documentation and changelog are English-only, including their navigation, descriptions, and the homepage's recent-release summaries. Vietnamese readers who switch languages cannot continue reading the same section in Vietnamese.

## Goals

- Provide a Vietnamese counterpart for every English indexable site page: home, download, all eight documentation pages, and changelog.
- Translate every published and unreleased release note currently shipped by the site (v0.3.0–v0.6.0), along with the homepage's recent-release summaries.
- Keep the 404 page bilingual as it is today.
- Keep route counterparts aligned: `/docs/...` ↔ `/vi/docs/...`, `/changelog/` ↔ `/vi/changelog/`, `/download/` ↔ `/vi/download/`, and `/` ↔ `/vi/`.
- Localize page titles and descriptions, documentation sidebar and notices, global navigation and footer destinations, and homepage changelog links.
- Emit a canonical URL per page, reciprocal `hreflang="en"` / `hreflang="vi"` and `x-default` on every paired page, and include every indexable localized page in the sitemap.

## Content sources

- Keep English documentation sourced from the existing README sections, `SECURITY.md`, concepts content, and CLI help output.
- Add maintained Vietnamese Markdown counterparts under `website/src/content/vi/docs/`, one per non-generated documentation page. The generated overview and command reference use localized page copy and command summaries while preserving the actual command names, usage and flags.
- Keep English release notes in `docs/releases/`. Add Vietnamese counterparts under `website/src/content/vi/releases/`, keyed by the same version tags. A test must fail when either language is missing a docs page or a release counterpart.
- Preserve code fences, CLI commands, flags, paths, environment variables, product names, and exact protocol or schema identifiers. Translate explanatory prose, headings, and user-facing labels.
- Do not translate dynamically generated versions, dates, download assets, or repository paths.

## Routes and rendering

Render documentation and changelog once per language. Vietnamese docs live under `/vi/docs/`; Vietnamese changelog lives at `/vi/changelog/`. The active language controls the header, footer, documentation sidebar, current-page marker, and all local links. The language switcher points to the corresponding route, not always to a language homepage. Tag-level changelog anchors stay identical in both languages so homepage links to a release remain stable.

Set each rendered page's `PageMeta.lang`, `canonical`, and `alternates` to its route and exact counterpart. The existing layout then emits matching HTML language metadata and `hreflang` tags. The build sitemap includes both sets of routes and continues to omit the bilingual 404.

The homepage receives the release-note set for its language so release teasers, the latest-release link, and recent-history anchors stay in that language. A Vietnamese home page links to `/vi/changelog/`; the English home page links to `/changelog/`.

## Alternatives considered

1. **Keep English sources and add Vietnamese Markdown counterparts (recommended).** This preserves existing README/release-note ownership and minimizes churn. A route/tag parity test guards synchronization.
2. **Move both languages into one new structured content model.** This makes the site a self-contained source for both locales but duplicates English content away from the README and changes every documentation input at once.
3. **Translate during the build.** Rejected because output quality would be unpredictable and builds would depend on a translation service.

## Validation

- Tests assert the expected English and Vietnamese route sets pair one-to-one, every release tag has both note files, and each page has correct language, canonical, and reciprocal alternates.
- Existing rendered-page checks run against both languages, including internal links, heading ids, title and description bounds, and sitemap membership.
- Focused website tests run first; required gates then run sequentially: `bun run typecheck`, `bun test --max-concurrency=1`, and `bun run build`. The website is built for `crossweave.dev` and its generated routes and metadata are inspected.

## Scope and limits

This adds site localization only. It does not translate the GitHub README, source-code comments, CLI output, or files outside the public website. Human proofreading by an independent Vietnamese technical writer is not included; that limitation will be recorded with the implementation.
