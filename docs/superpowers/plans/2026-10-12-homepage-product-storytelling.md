# Homepage Product Storytelling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the homepage workflow diagram into a layered, scroll-settling 2.5D product illustration while preserving its static-site architecture and accessible fallback.

**Architecture:** `diagramSvg(label, details)` returns one localized inline SVG group with individually named, keyboard-operable targets. Use SVG layers for repository, sessions, merge results, and land flow; token-based CSS adds restrained styling, moving route dashes, and feature-detected view-timeline movement. The static SVG remains complete without animation support.

**Tech Stack:** Bun, TypeScript, dependency-free static HTML renderer, inline SVG, CSS, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-12-homepage-product-storytelling-design.md`

## Global Constraints

- Runtime/build remains Bun ≥ 1.3.13 and TypeScript; add no dependencies or native modules.
- Keep the static GitHub Pages build and EN/VI content.
- Use cockpit-derived CSS tokens; do not add literal colors.
- Every animation/transition must be under `prefers-reduced-motion: no-preference`; reduced-motion leaves the final scene visible.
- Keep changes limited to the homepage diagram, its localized content, the small shared site-script interaction, its tests, and milestone documentation.

---

### Task 1: Layer the workflow illustration and animate it progressively

**Files:**
- Modify: `website/src/diagram.ts`
- Modify: `website/src/content/en.ts`
- Modify: `website/src/content/vi.ts`
- Modify: `website/src/styles.css`
- Test: `website/tests/home-v2.test.ts`
- Test: `website/tests/motion.test.ts`
- Create: `docs/superpowers/specs/2026-10-12-homepage-product-storytelling-known-limitations.md`
- Modify: `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`

**Interfaces:**
- Keep `diagramSvg(label: string, details: DiagramDetails): Html` and its single inline SVG boundary; the SVG is a named group containing focusable explanation controls.
- Add a stable SVG group per logical layer: shared main/repository, three sessions, trial merge, blocked verdicts, ready verdict, and land path.
- CSS consumes those group classes and adds optional `animation-timeline: view()` behavior only inside the existing motion-preference gate.

- [x] **Step 1: Add contract tests first.** In `website/tests/home-v2.test.ts`, extend the diagram test to require exactly three session groups plus explicit repository, trial-merge, two-conflict, ready, and land layers, while retaining the existing role, localized label, no-inline-style, no-script, and escaping assertions. In `website/tests/motion.test.ts`, add a test that the view-timeline choreography is inside `prefers-reduced-motion: no-preference`, guarded by `@supports (animation-timeline: view())`, animates only transform-compatible properties, and leaves the default scene statically positioned.

- [x] **Step 2: Run the focused tests to verify RED.** Run `bun test --max-concurrency=1 website/tests/home-v2.test.ts website/tests/motion.test.ts`. The diagram layer assertions must fail because the current SVG is a flat path diagram; fix any test typo before implementation.

- [x] **Step 3: Implement the SVG layers.** Update `diagramSvg` to draw the repository/main lane, three offset session panels (api, web, docs), their trial-merge connections, two blocked result marks, and one ready path returning to main. Update the EN/VI accessible descriptions to match the new composition. Keep labels escaped through `escapeHtml`, keep shape classes free of inline styles, and keep the final viewBox composition readable at its rendered width.

- [x] **Step 4: Add token-based 2.5D styling and progressive motion.** Style the workflow as a compact cockpit-like scene using existing surface, border, session, ready, and blocked tokens. Add perspective/depth via layered SVG shapes and restrained shadows. Add view-timeline settling under both `@media (prefers-reduced-motion: no-preference)` and `@supports (animation-timeline: view())`; leave the base SVG in its final arrangement for unsupported browsers and the reduced-motion path.

- [x] **Step 5: Run focused website tests and inspect generated HTML.** Re-run the two focused test files. Build with `SITE_URL=http://127.0.0.1:4173 SITE_BASE= bun website/build.ts`; inspect both `/` and `/vi/` from the local preview for one SVG, the appropriate localized aria-label, and the three session groups.

- [x] **Step 6: Run the required repository gates sequentially.** Measure system load first. Run `bun run typecheck`, then `bun test --max-concurrency=1`, then `bun run build`, one at a time. The website source is also typechecked by the root test/build conventions; no cockpit build is needed because `apps/cockpit/` is untouched.

- [x] **Step 7: Complete milestone limitations documentation.** Record browser support/fallback and the narrow scope in `2026-10-12-homepage-product-storytelling-known-limitations.md`; append one dated line to the known-limitations digest. Preserve every pre-existing uncommitted change and do not commit without explicit approval.

- [x] **Step 8: Visual review and handoff.** Refresh the existing local preview, inspect desktop and mobile widths in a browser if available, correct any clipping/overlap, and report the URL plus each gate's real result. Do not claim browser inspection if the current environment cannot provide it.

### Task 2: Flatten the illustration and animate route flow (visual feedback)

**Files:**
- Modify: `website/src/diagram.ts`
- Modify: `website/src/styles.css`
- Test: `website/tests/home-v2.test.ts`
- Test: `website/tests/motion.test.ts`
- Update: this plan, the design spec, and the known-limitations record

- [x] **Step 1: Pin the visual contract.** Add tests rejecting the extruded card/window-chrome treatment and requiring flow-marked route paths. Add a motion test that line dashes move only under `prefers-reduced-motion: no-preference`.
- [x] **Step 2: Flatten the SVG and surfaces.** Remove offset shadows, fake terminal chrome, perspective, and pill outlines. Keep workflow labels and branch/status colors readable with restrained token-based surfaces and rules.
- [x] **Step 3: Animate connected routes.** Keep a still base route and overlay moving dashes on session, trial-merge and land paths. Retain the reduced-motion static view and the existing supported scroll-settling enhancement.
- [x] **Step 4: Run focused tests.** `bun test --max-concurrency=1 website/tests/home-v2.test.ts website/tests/motion.test.ts` — 47 pass, 0 fail.
- [x] **Step 5: Rebuild and visually inspect the local preview.** Check desktop and narrow widths, ensure animated flow reads clearly, then run `git diff --check`.

### Task 3: Explain every part of the workflow on hover or selection

**Files:**
- Modify: `website/src/content/types.ts` — type localized diagram details.
- Modify: `website/src/content/en.ts`, `website/src/content/vi.ts` — provide accurate localized overview and part descriptions.
- Modify: `website/src/diagram.ts` — name focusable SVG targets and provide native titles.
- Modify: `website/src/pages/home.ts` — render the live overview/detail panel.
- Modify: `website/src/styles.css` — affordances and panel styling.
- Modify: `website/public/site.js` — delegated hover/focus/tap detail updates.
- Test: `website/tests/home-v2.test.ts`, `website/tests/site-script.test.ts` — pin markup, localization, escaping, pointer, focus, keyboard, and touch behavior.

- [x] **Step 1: Add failing contracts.** Require distinct accessible targets for routes, repository, all three sessions, trial merge, ready, blocked, and land. Require localized detail text and a default overview panel. Extend the site-script harness to test pointer updates/reset, focus updates, keyboard activation, and touch selection persistence.
- [x] **Step 2: Run focused tests and confirm RED.** Run `bun test --max-concurrency=1 website/tests/home-v2.test.ts website/tests/site-script.test.ts`; failures should show the missing diagram targets and explorer behavior.
- [x] **Step 3: Add typed EN/VI detail copy and SVG targets.** Pass a `DiagramDetails` record through `homePage` into `diagramSvg`; escape each detail in `data-diagram-detail`, `aria-label`, and `<title>`. Give the SVG a group role so its nested keyboard-operable targets remain exposed.
- [x] **Step 4: Add the shared explanation panel and event delegation.** Render a localized static overview by default. Use `textContent` to update it on pointer hover, keyboard focus/activation, and touch click; restore the overview when pointer/focus leaves the explorer. Do not inject HTML or add inline event handlers.
- [x] **Step 5: Style clear hover/focus states and verify both languages.** Keep the panel readable and compact, show focus without relying on color alone, and confirm English/Vietnamese copy remains in sync.
- [x] **Step 6: Run focused tests, typecheck, full root tests, and build sequentially.** Rebuild the site and inspect hover, keyboard, desktop, and narrow-width behavior in the local browser; run `git diff --check`.
- [x] **Step 7: Finish milestone docs and preserve checkout state.** Record browser tooltip/touch behavior and scope in the known-limitations note/digest. Do not commit without explicit approval.
