# Plan — cockpit motion

Spec: `docs/superpowers/specs/2026-09-29-cockpit-motion-design.md`
Branch: `feat/cockpit-motion`
Tier: Medium — tokens, a FLIP helper, Stage/rail wiring, CDP verification.

## Tasks

1. [x] **Motion tokens.** Add `--cw-dur-layout` (180 ms), `--cw-dur-slow` (220 ms),
   `--cw-ease-out` and a `linear()` spring to `tokens.ts`, each with a one-line WHY.
   Every duration/easing is a token referenced by `var()` (the stylesheet's no-literal
   test forbids inline values). Extend `tokens.test.ts`.
2. [x] **FLIP helper.** `apps/cockpit/src/lib/flip.ts` — capture rects, inverse
   **translate**, animate to identity (WAAPI), resolve on `finished`; **check
   `matchMedia('(prefers-reduced-motion: reduce)')` and no-op** (WAAPI is not affected by
   the CSS rule). Translate/opacity only — never scale a terminal surface. Commit/cancel
   any previous animation on the pane before capturing `First`; measure `Last` in a
   `useLayoutEffect` (Preact batches renders). Pure rect maths tested in
   `apps/cockpit/tests/flip.test.ts`, including the reduced-motion no-op.
3. [x] **Size vs position.** Never pause fit. A size change snaps the final box and lets
   the existing `ResizeObserver`/`applyFit` fit immediately (`XtermPane.tsx:112`,
   `:174-176`), with an opacity fade; a position-only change animates with translate and
   does not touch the pty.
4. [x] **Structural animation.** Wire FLIP into `Stage` for split, close, swap, preset and
   cross-tab move.
5. [x] **Tab switch.** Cross-fade the stage body; choose and document layered
   `opacity`/`visibility` or `@starting-style` + `transition-behavior: allow-discrete` for
   a two-way fade (the inactive tab is `display:none`).
6. [x] **Project switch.** Plain **cross-fade** (no View Transitions — they freeze live
   terminal output).
7. [x] **Rail choreography.** Status dot transitions, land chip and overlap badge
   fade-in/out, one restrained attention pulse (never a loop).
8. [x] **Gates + CDP.** Root `bun run typecheck`, `bun test --max-concurrency=1`,
   `bun run build`; cockpit `bun test`, `bun run build`; a CDP trace during a split/close
   and a tab switch (no long tasks, sustained frame rate) with reduced-motion on and off,
   + a screenshot.
9. [x] **Docs.** Known-limitations file + digest line.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build` · cockpit
`bun test` + `bun run build` · CDP FPS/visual check with reduced-motion on and off.

## Report

Screenshot/trace plus the measured frame rate and long-task check before this phase is
called done.
