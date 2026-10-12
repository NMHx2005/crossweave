# Website search descriptions

## Problem

The English and Vietnamese home pages emit descriptions longer than 160 characters. Search engines may truncate them, hiding the product's defining workflow in search snippets.

## Design

Keep the site static and dependency-free. Rewrite only the two home page descriptions to explain parallel coding sessions, their isolated worktrees and shells, and trial-merging before landing. Keep each at or below 160 characters. Add a build-level test that checks every indexable output page has a description within that bound; pages explicitly marked `noindex` are exempt.

No structured-data, route, build, analytics, or sitemap behavior changes are part of this work.

## Acceptance

- Both localized home pages have concise, accurate descriptions of crossweave.
- Every indexable generated page has a description no longer than 160 characters.
- Website tests and the required repository gates pass.
- Search Console impressions, rankings, and snippet selection remain unverified after publishing.
