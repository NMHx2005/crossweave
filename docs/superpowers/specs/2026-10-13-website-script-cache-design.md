# Website script cache key design

## Context

The workflow diagram's hover explanation is implemented in `website/public/site.js`, but the generated HTML references the script at a stable `/site.js` URL. GitHub Pages and its CDN may retain that URL for hours. A visitor can therefore receive new HTML and SVG markup while their browser reuses a script from before the explainer existed.

## Decision

Compute a short SHA-256 fingerprint from the exact public `site.js` bytes during the static build and append it as a `v` query parameter to the script URL in every generated page. Keep the emitted file path unchanged so static hosting remains dependency-free and existing routing continues to work. Add build and layout contract tests that prove the URL matches the emitted bytes for both the project base path and a custom domain.

## Scope

Only website script cache invalidation is addressed. The workflow's pointer/focus/touch interaction and reduced-motion behavior are unchanged. Images and video retain their current cache behavior.

## Verification

Run focused website tests, then `bun run typecheck`, `bun test --max-concurrency=1`, and `bun run build` sequentially. Build the website and inspect the generated script URLs before deployment; verify the live HTML and script after Pages completes.
