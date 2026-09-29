# Cockpit motion — known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-motion-design.md` · Branch `feat/cockpit-motion`

## What shipped

- Motion tokens: `--cw-dur-layout` (180 ms), `--cw-dur-slow` (220 ms), `--cw-ease-out`,
  `--cw-ease-spring` (`linear()`); `tokens.test.ts` keeps every transition at or under 220 ms.
- `lib/flip.ts` (FLIP: translate for a moved pane, fade for a resized or new one, never a
  scale; a no-op under `prefers-reduced-motion`, which WAAPI would otherwise ignore), wired into
  `Stage` for split, close, swap, preset and drag-move. Only a change of *structure* animates:
  a divider drag or a window resize does not.
- A tab (and, with it, a project) fades in; the rail's status dot changes colour by transition,
  the git counts, land chip and overlap badge fade when they appear or change value, and a dot
  that starts asking pulses once.
- `apps/cockpit/scripts/motion-check.ts`: CDP gate over split, close and a tab switch.

## Measured (a real app window, 100 Hz display, one shell session per tab)

| | split | close | tab switch | frames >33 ms | long tasks |
|---|---|---|---|---|---|
| motion on | 2 animations | 1 | 1 | 0 of 170 | 0 |
| reduced motion | 0 | 0 | 0 | 0 of 170 | 0 |

Animations are counted by real duration and without the rail's endless spinner. One run on one
machine: indicative, and the screenshot is a still, so it shows the result, not the motion.

## Limitations

- **Enter-only fades.** The outgoing tab or project is `display:none`, which cannot fade, so a
  switch fades the new view in without cross-fading the old one out. A project with no tabs
  (the welcome placeholder) does not fade. A true two-way fade needs the tabs layered.
- **A closed pane vanishes at once**; only the panes that remain move or fade.
- **A resized pane fades rather than glides.** Splitting halves the original pane, so it fades
  while its terminal has already refitted; sliding a resized box would need a scale, which
  distorts the text. Only a pane that changes position alone slides.
- **A pane moved to another tab is not animated** (the tab switch fade covers it).
- **A new structure interrupts a running animation** with a jump to the new layout, and an
  unrelated re-render never cuts one short.
- **Measured on every render** of the stage: one layout read of the shown tab's panes, cheap
  but not free. Visibility comes from the stage measuring 0x0 when its project is off screen.
- **The attention pulse also plays** when a row that is already asking first appears (app
  start, a remount): it is keyed to the state class, not to the transition into it.
- **The task chip count** named in the design has no counterpart in the rail today, so only the
  git counts, land chip and overlap badge fade between values.
- **Terminal contents are never animated**: output and scroll are unchanged by design.
