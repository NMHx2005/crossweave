# Website documentation search and version snapshots

## Problem

The site publishes documentation pages from the current README, generated references and localized content. Readers cannot search across them or switch to the documentation that shipped with an earlier release. The release tags contain the original English README, but they predate the site's Vietnamese documentation, so an old Vietnamese translation cannot be presented as historical source material.

## Decision

- Keep the existing `/docs/` and `/vi/docs/` pages as the current documentation, explicitly marked as following `main`.
- Publish one archive page per released version at `/docs/versions/<tag>/`, rendered from the exact `README.md` stored in that Git tag. Preserve its headings and link targets, and identify the source tag on the page. Do not merge current-only Concepts, generated command reference or later security material into an older snapshot.
- Keep the version selector and surrounding site chrome localized. Historical snapshots are English source documents; on the Vietnamese docs index, label that distinction and keep the current Vietnamese documentation available as a separate choice. Never label current Vietnamese copy as a tag-accurate translation.
- Add a localized search control to the current documentation overview. It searches the selected source scope (current docs or a chosen release; optionally all versions), and reports the source version and section with each result. A result links to its page and heading.
- Generate per-language static search indexes from the same documents used to render pages. The browser loads only the selected index, uses local matching and shows a bounded number of results. No search vendor, server endpoint, framework or new package is introduced. Permit same-origin index requests in the existing CSP; escape rendered excerpts and retain a clear empty/error state.
- The Pages workflow must fetch the released tags required by the build. The builder reads tags and file paths as arguments to `git`, never as shell text, and fails the build if a published release has no corresponding tag README. Unit tests inject snapshot inputs so test fixtures do not depend on a network or a user's local tag list.

## Interaction and accessibility

- Search works with a labeled input, native version select and keyboard. Results have a polite live count, descriptive link names and a no-results message in the selected language.
- Search is an enhancement: current documentation pages and archive pages remain complete HTML when JavaScript is unavailable. A missing/unreadable search index leaves a localized, non-fatal message and does not hide documentation.
- Selected version and query are represented in the page URL so a search can be shared. Back/forward restores the controls and results.

## Scope and limits

- Snapshot pages contain the tag's README because that is the stable, user-facing documentation source present at every supported release tag. A page does not claim to reconstruct generated `cw --help` output or site-only translations from that release.
- Snapshot pages are English by source. The Vietnamese interface states this before linking to them; the current Vietnamese docs remain separate and accurate for `main`.
- Only tags represented by published release notes enter the selector. Prerelease tags and removed historical product lines are excluded.
- Search is client-side and limited to the static index. It is not a server-side search service and does not index arbitrary repository files.

## Verification

Test snapshot discovery and tag README rendering with injected data; test bilingual current-page search indexes, result routing, URL state, empty/error behavior and HTML escaping; test a browser interaction with keyboard and no-JavaScript content visibility. Build both GitHub Pages base-path and custom-domain output, assert all snapshot/index assets are present and linked, run root typecheck and sequential tests, and verify the deployed Docs flow in Chromium at desktop and mobile widths.
