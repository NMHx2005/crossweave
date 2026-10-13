# Homepage product storytelling redesign

## Goal

Give the Crossweave homepage a more vivid, premium product story by turning its existing flat workflow diagram into a layered 2.5D illustration of parallel sessions, trial merges, and landing work back to `main`.

## Audience and design direction

This is a product landing page for developers evaluating a multi-session workflow tool. Keep the current dark cockpit palette, typography, content hierarchy, and readable Linear-like product clarity. Use a flat, editorial workflow diagram with restrained borders and purposeful route motion; avoid fake terminal chrome, stacked card shadows, and perspective that make the illustration feel plastic.

## Scope

- Update only the homepage's existing “How it works” illustration.
- Show one shared `main` repository, three visibly separate session/worktree panels, trial-merge evidence, two blocked outcomes, and one clean path that lands into `main`.
- Keep the diagram's localized, accurate accessible description and use the existing color tokens for the session and verdict states.
- Use semantic SVG shapes and native CSS. The scene must remain fully visible and understandable as a static picture when animation is unavailable or reduced motion is requested.
- Animate short dashes along the repository-to-session, trial-merge, and land routes when motion is allowed. Keep scroll-linked session settling subtle and flat; never take control of scrolling or hide essential information.
- Make the diagram an explorable overview: hovering a node or route updates a concise detail panel and exposes a native SVG tooltip; keyboard focus and touch selection provide the same explanation.
- Keep the existing generated static HTML architecture, public routes, video, and other page sections unchanged.

## Non-goals

- No Next.js/Astro migration, Spline/Three.js/WebGL, third-party scripts, new dependencies, or remote assets.
- No redesign of the header, hero video, feature groups, download page, or docs pages.
- No changes to Crossweave product behavior or claims.

## Accessibility and resilience

- The SVG remains one named image for assistive technology; decorative internal layers do not create extra announcements.
- Interactive nodes and route groups are keyboard-focusable controls with localized accessible names; the live detail panel is announced when the selection changes.
- The final visual state is the stylesheet fallback, so lack of `animation-timeline: view()` cannot remove or displace content.
- All motion is inside `prefers-reduced-motion: no-preference`; the existing reduced-motion rule disables animations and transitions.
- The illustration remains fluid at mobile widths, with compact details allowed to simplify while preserving the workflow and verdicts.

## Acceptance criteria

1. English and Vietnamese homepages retain one localized description for the workflow illustration.
2. The rendered SVG includes a shared repository/main layer, three session layers, a trial-merge decision, two blocked results, and one ready/land path.
3. CSS applies existing theme tokens to flat diagram surfaces and route strokes without literal colors or inline styles.
4. Route dashes move only with `prefers-reduced-motion: no-preference`; reduced-motion users see the complete static routes. Scroll-linked settling remains guarded by feature support and motion preference.
5. Hover, keyboard focus, and touch selection all reveal localized detail for the repository, session worktrees, trial merges, verdicts, and land route.
6. Relevant website tests, typecheck, and website build pass; inspect the updated local homepage at desktop and narrow viewport sizes where the available browser tooling permits.

## Known limitations to record

- Scroll-linked movement depends on browser support for CSS view timelines; older browsers receive the static final artwork.
- This milestone changes one diagram, not the rest of the homepage or site-wide motion language.
