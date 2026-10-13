# Website SVG cache mismatch fix

> **For agentic workers:** Use the `executing-plans` workflow. The root cause is documented in `docs/superpowers/specs/2026-10-13-website-stylesheet-cache-design.md`.

**Goal:** Prevent browsers from pairing newly deployed workflow SVG markup with a stale, long-lived stylesheet that leaves SVG shapes and text black.

**Architecture:** Fingerprint the exact generated theme-plus-site CSS with SHA-256 and add that fingerprint as a query parameter to each page's stylesheet URL. Keep the file at `/styles.css`; only its URL cache key changes when contents change.

**Tech:** Bun, TypeScript, static HTML build, `bun:test`.

## Steps

1. [x] **RED:** Add tests that rendered HTML exposes the CSS cache key and the build's pages use the SHA-256 fingerprint of the exact emitted stylesheet. Focused layout/build tests failed on the expected unversioned stylesheet URLs.
2. [x] **GREEN:** Pass the stylesheet fingerprint from `build.ts` into `renderDocument`; derive it from the exact CSS string written to disk. Update direct renderer tests and keep the CSS file path unchanged. The focused website tests pass (37 tests).
3. [x] Run website tests, root `typecheck`, and root tests with concurrency 1 sequentially. Build the production site and verify the versioned URL plus computed SVG fill/text colors in Chrome at desktop and 390px mobile widths. The binary build is unchanged because `src/` was not touched.
4. [x] Record limitations and one line in the known-limitations digest; update progress/handoff, review the diff, commit `3f55445`, fast-forward `main`, and verify Pages run `38328432704`, CI run `38328432710`, and the live stylesheet URL.

## Scope

Modify `website/src/layout.ts`, `website/build.ts`, and focused website tests. Add this design/plan, a dated known-limitations record, and update the digest/progress handoff. Do not change the diagram drawing, palette, or animation.
