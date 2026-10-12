# Professional bilingual subpages design

## Problem

The public website's home page has a strong product-storytelling treatment, but the Download, Documentation and Changelog pages still read as lightly styled content dumps. These pages are where developers need to make decisions, find commands, and inspect release history; they should be as clear and navigable as a mature developer portal.

## Goals

- Give Download a clear current-release summary, an obvious recommended install path, and grouped app/CLI/platform assets without changing release asset URLs or safety notices.
- Give Documentation a familiar reference layout: section navigation, readable article column, and a generated on-page contents list from existing Markdown headings on wide screens.
- Give Changelog a release index that links to stable tag anchors and a readable release timeline, including the unreleased entry when present.
- Keep all page chrome and new explanatory copy localized in English and Vietnamese.
- Keep the site statically generated, dependency-free, responsive, keyboard accessible, and consistent with Crossweave's token system.
- Preserve the homepage and its approved 2.5D product-storytelling design unchanged.

## Design

Use the existing Crossweave dark/light tokens, typography, border and radius system. Add editorial hierarchy and restrained surfaces instead of adopting Node.js branding. Download uses a broad release header with release tag/date, a primary Cockpit download action and separate CLI install/reference area. Docs uses a three-column desktop grid (section navigation, article, on-page contents) that collapses to a compact section navigation and hides the contents rail on narrow screens. Changelog uses a narrow release index beside a comfortable article column on desktop, with release IDs preserved from tag strings; on mobile the index becomes a horizontal, wrapping list above the entries.

All controls remain ordinary anchors and native HTML. New labels are typed in the English and Vietnamese content models. The Docs contents list is generated from rendered heading IDs and links to the current page. No JavaScript, framework, dependency, route, command, asset naming, or release source changes are required. Respect `prefers-reduced-motion`; no motion is needed for these reference pages.

## Acceptance criteria

- EN/VI Download pages show the same release identity, clearly group Cockpit and CLI assets, and keep the notarization caveat, checksum and fallback behavior intact.
- EN/VI Docs pages retain their current page/sidebar/meta and gain a localized, accessible on-page contents navigation where headings exist; links resolve to rendered heading IDs.
- EN/VI Changelog pages show a localized release index whose anchors match the existing stable release section IDs and preserve release ordering, dates, unreleased badges and rendered notes.
- All 22 indexable site routes and their canonical/hreflang metadata remain unchanged and valid.
- Responsive CSS avoids horizontal page overflow at narrow widths and reuses token variables.
- Tests cover localized navigation labels, IDs/targets and content contracts. Root gates pass sequentially, and the production site can be generated for local preview.

## Limits

The static site does not provide client-side search, versioned docs snapshots, or release filtering. Those would need separate content and interaction requirements. The site's EN/VI copy remains manually maintained and still benefits from independent Vietnamese technical proofreading.
