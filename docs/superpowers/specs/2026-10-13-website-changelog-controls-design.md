# Website changelog filtering and pagination

## Problem

The bilingual Changelog renders every release on one long page. Its release index is useful for jumping to an entry, but there is no way to narrow releases by version, change type or words in the notes, and the page grows without bounds as new releases are added.

## Decision

- Keep the static page and render every release in the HTML so the content remains available without JavaScript and to crawlers.
- Add localized controls for release version, note type (derived from each release's Markdown section headings) and text query over the release title and rendered text.
- Show three matching release sections per page by default, with previous/next controls and a localized result count. Three is intentional: it demonstrates paging against the four currently published release notes while keeping older releases reachable.
- Carry query, version, type and page in query parameters. Updating a filter resets the page to one; back/forward restores state. Preserve `#vX-Y-Z` anchors by selecting the containing page when an anchor is opened.
- Keep controls hidden until the local script initializes successfully; without JavaScript all releases and the release index stay visible. A script failure never leaves a filtered or empty page.
- Use native form controls, visible labels, keyboard support and a polite live result count. Preserve the existing release IDs, heading hierarchy, language alternates, metadata and internal links.

## Scope and limits

- Type options come from the semantic top-level sections already used by release notes (for example New, Changed, Fixed and Removed), with localized labels. Missing a type from one release is a normal no-match result.
- Search and filtering are client-side over the release content already embedded in the page. No remote index, backend, framework or dependency is added.
- Pagination is over releases, not individual note bullets; one release remains a coherent unit.

## Verification

Test category extraction from representative release notes, combination of query/version/type filters, stable ordering, page boundaries, anchor-to-page selection and bilingual control labels. Verify the current four releases exercise at least two pages, all releases remain visible without JavaScript, and no result-count or URL state leaks between the EN and VI routes. Run the website build and tests, root typecheck and sequential full test suite, then review both live-language pages in Chromium at desktop and mobile widths.
