# Cockpit motion — full animation, cheap and honest

**Date:** 2026-09-29
**Status:** Planned
**Scope:** `apps/cockpit/src/ui/app.css`, `apps/cockpit/src/ui/tokens.ts`,
`apps/cockpit/src/lib/flip.ts` (new), `apps/cockpit/src/ui/Stage.tsx` and the rail.
**Branch:** `feat/cockpit-motion`

## Problem

The cockpit's motion is deliberately thin today: `--cw-dur-fast 90ms`, `--cw-dur 140ms`,
`--cw-dur-enter 120ms`, `--cw-lift 4px`, a 1600 ms spin, one easing
(`cubic-bezier(0.2, 0, 0.2, 1)`) in `tokens.ts:145`, and three keyframes
`cockpit-enter` / `cockpit-rise` / `cockpit-fade` (`app.css:227`). Menus, popovers,
dialogs and toasts animate; **structural change does not** — splitting, closing, swapping
or re-laying-out a pane swaps the tree instantly, tab switches are instant, a project
switch is instant. The user asked for full motion.

## Principles

1. **Never animate terminal contents.** Output reaches xterm untouched and un-delayed;
   motion is chrome only.
2. **Compositor-only.** Animate `transform` and `opacity`; never `width`/`height`/`top`/
   `left`, and never a scale on a terminal surface.
3. **Reduced motion wins.** **WAAPI `element.animate()` is NOT affected by the CSS
   `@media (prefers-reduced-motion)` rule** (`app.css:705`) — it only collapses CSS
   transitions/animations. `flip.ts` must itself check
   `matchMedia('(prefers-reduced-motion: reduce)')` and no-op.
4. **Short.** Nothing above ~220 ms.
5. **Fit when the size changes, immediately.** A pane that only changes **position** is
   animated with translate and never touches the pty (the `ResizeObserver` fires only on a
   size change). A pane that changes **size** is snapped to its final box and fitted at
   once — so the DOM box and the character grid agree — with only an opacity fade over it.
   No paused fit, no stale grid.

## 1. Tokens

Extend `COCKPIT_TOKENS` with `--cw-dur-layout` (~180 ms), `--cw-dur-slow` (~220 ms),
`--cw-ease-out`, and a spring easing (CSS `linear()`), each with a one-line WHY. The
design-system test forbids dimensional literals in the stylesheet (only `100%`, `100vh`,
`0.01ms` are allowed — `tokens.test.ts:78-86`), so **every new duration and easing must be
a token referenced by `var()`**, never written inline. `tokens.test.ts` keeps its
no-literal and reduced-motion checks.

## 2. FLIP for structural change

New helper `apps/cockpit/src/lib/flip.ts`: capture pane-wrapper rects before a layout
change, apply the inverse **translate** after, animate to identity with the Web
Animations API. Used by `Stage` around split/close/swap/preset and pane move.

- **Translate + opacity only — no scale.** A scale inverse would stretch the xterm canvas
  while the terminal has already reflowed to the new cell count, so text looks wrong for
  the duration. When a pane's **size** changes, snap the size and fade; only **position**
  changes animate with translate.
- **No paused fit.** An earlier draft added a `fitPaused` flag; it is self-contradictory —
  holding the pty at the old size while the DOM box is final leaves a gap or a crop. Since
  a size change snaps the box, the pane's `ResizeObserver` (`XtermPane.tsx:112`, `:174-176`)
  fits immediately and the pty matches the box; only position changes are animated by
  transform. There is nothing to pause.
- **Measure correctly.** Capture `First` only after any previous animation on the same pane
  has been committed or cancelled, or the delta is wrong. Measure `Last` in a
  `useLayoutEffect`, because Preact batches renders.
- **Reduced motion:** the helper returns immediately when the media query matches, so no
  animation and no fit delay.
- The rect maths is unit-testable without a browser; the animation is checked by a CDP
  trace.

## 3. Tabs and projects

- **Tab switch:** cross-fade the stage body. Today the inactive tab is `hidden`
  (`display:none` — `Stage.tsx:404`), so only *enter* can animate; a true two-way
  cross-fade needs the panes layered with `opacity`/`visibility` (keeping layout) or
  `@starting-style` + `transition-behavior: allow-discrete` (Electron's Chromium supports
  both). Pick one and document it.
- **Project switch:** a plain **cross-fade, not a View Transition.** A View Transition
  freezes the page on a static snapshot for its duration, so live terminal output would
  stall — violating principle 1 — and terminal panes cannot be excluded from the root
  snapshot. View Transitions are dropped from this plan.

## 4. Rail choreography

- The rail row enter already animates (`cockpit-enter`); add the state changes that carry
  meaning: the status dot (working/asked/done/failed) transitioning, the land chip
  appearing, and a single restrained attention pulse when a session starts asking — never
  a loop. The task chip count and overlap badge fade between values rather than snapping.

## Testing

- `apps/cockpit/tests/flip.test.ts` — delta transforms, identity at end, no-op when rects
  match, **no-op under `prefers-reduced-motion`**.
- `apps/cockpit/tests/tokens.test.ts` — motion tokens present; reduced-motion still
  collapses; no new dimensional/colour literals.
- CDP: a trace during a split/close and a tab switch, asserting no long tasks and a
  sustained frame rate, with reduced-motion on and off; a screenshot for the record.

## Risks

- **Distortion** — never scale a terminal surface; size changes snap + fade.
- **Fit vs animation** — no paused fit; a size change fits immediately, position-only
  changes never touch the pty.
- **Perceived latency** — nothing animates on the keystroke path.

## Review revisions (2026-09-29)

Round 1: WAAPI ignores the CSS reduced-motion rule, so `flip.ts` checks the media query
itself; FLIP is translate/opacity only; **View Transitions dropped** for project switch;
new durations/easings must be tokens.

Round 2: **`fitPaused` removed** — it contradicted itself (a final DOM box with an old pty
size leaves a gap or a crop); a size change now fits immediately and fades, a position-only
change translates and never fits. Added: commit/cancel a previous animation before
capturing `First`, and measure `Last` in `useLayoutEffect` (Preact batching).

## Known limitations (to write at merge)

- Motion is chrome-only; terminal scroll and output stay unanimated.
- Tab/project cross-fades are enter-biased unless the layering work lands; documented.
