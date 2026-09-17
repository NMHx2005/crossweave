# Cockpit design system — borrowed material, our anatomy

**Date:** 2026-09-17
**Status:** Implemented (`apps/cockpit/src/ui/tokens.ts`, `app.css`, `XtermPane.tsx`)
**Scope:** Cockpit (Electron) only. The CLI TUI (`cw tui`) inherits the terminal's own theme and is untouched.

---

## 1. What this is, and what it is not

The cockpit is the one surface in crossweave with a visual identity of its own, and
until this document it had none: ~25 hex literals scattered through a 288-line
stylesheet, plus a **second copy of the same palette** inlined in the xterm pane's
`Terminal({ theme })`. Two sources, guaranteed to drift.

This is a **token layer with a borrowed material language**, not a component library
and not a new visual concept:

- **One source of truth.** `COCKPIT_TOKENS` in `src/ui/tokens.ts` is published as
  CSS custom properties at boot (`applyTokens()` in `main.tsx`) and read directly by
  `XTERM_THEME`. A colour can no longer exist in the CSS but not in the palette.
- **Borrowed, and honest about it.** Cursor publishes no design system, so the
  vocabulary is VS Code's workbench role names and the values are read out of the
  theme this repository is developed in — Cursor + **One Dark Pro Night Flat**
  (`zhuangtongfa.material-theme`). Every role keeps a one-line provenance comment.
- **Anatomy is ours.** Cursor's layout (title bar → sidebar → editor group → status
  bar) is deliberately *not* copied: the rail, stage and footer express landability
  and attention, which is the thing crossweave has that an editor does not. Copying
  the anatomy would produce a worse Cursor, not a better crossweave.
- **No assets are copied.** Not their logo, not their fonts, no bundled theme file —
  only the role vocabulary and the measured values.

## 2. Roles

| Token | Value | Source role |
|---|---|---|
| `--cw-surface` | `#16191d` | `sideBar.background` (also `editor`, `titleBar`, `statusBar` — the theme is flat) |
| `--cw-surface-input` | `#1d1f23` | `input.background` |
| `--cw-surface-hover` | `#2c313a` | `list.hoverBackground` |
| `--cw-surface-active` | `#323842` | `list.focusBackground` |
| `--cw-surface-control` | `#404754` | `button.background` |
| `--cw-surface-badge` | `#23272e` | `badge.background` |
| `--cw-border` | `#37393d` | `sideBar.border` |
| `--cw-border-strong` | `#3e4452` | `panel.border` |
| `--cw-text` | `#abb2bf` | `foreground` |
| `--cw-text-bright` | `#d7dae0` | `list.activeSelectionForeground` |
| `--cw-text-dim` | `#9da5b4` | `descriptionForeground` / `statusBar.foreground` |
| `--cw-text-disabled` | `#4f5666` | `terminal.ansiBrightBlack` |
| `--cw-accent` | `#61afef` | `textLink.foreground` |
| `--cw-cursor` | `#528bff` | `editorCursor.foreground` |
| `--cw-selection` | `#67769660` | `editor.selectionBackground` |
| `--cw-scrollbar` / `-hover` | `#4e5666` / `#5a6375` | `scrollbarSlider.background` / `.hoverBackground` |

Dimensions are tokens too, so a value can never be "almost the same" in two places:
`--cw-hairline` (1px — borders, the focus outline's width and its negative offset, row
separators and the meta gap all share it), `--cw-bar-w` (2px, the focused-row selection
bar), `--cw-control-pad-y`, `--cw-tracking-label` (0.08em on the uppercase micro
labels), `--cw-scrollbar-w` and `--cw-scrollbar-inset`. The only unit-bearing literals
allowed to remain are the three that describe structure rather than design: `100%`,
`100vh` (the shell fills the window) and `0.01ms` (what the reduced-motion override
collapses durations to).

Density (13px body, 24px rows, 3/5/7px radii, 4→14px spacing steps, 280px rail) and
motion (90ms/140ms, `cubic-bezier(.2,0,.2,1)`) follow the same theme's own numbers
where they exist and the editor convention where they do not.

## 3. Attention and landability roles

An editor theme has no concept of *working / needs you / blocked / conflict / ready /
unknown*, so these are sourced from the same theme's terminal palette instead of
invented hues — which is also why a badge and the agent's TUI beside it agree.

| Role | Token | Treatment |
|---|---|---|
| working | `--cw-working` `#4dc4ff` | wash: hue text on 16% of itself |
| ready | `--cw-ready` `#a5e075` | wash |
| needs you | `--cw-needs-you` `#f0a45d` | wash |
| blocked | `--cw-blocked` `#ff616e` | **filled**: dark text on 85% hue |
| conflict | `--cw-conflict` `#de73ff` | **filled** |
| unknown | `--cw-text-dim` | neutral |

Two measured decisions, not taste:

1. Roles use the palette's **bright** steps. As 11px badge text over its own wash the
   plain steps measure ~4.0:1 and fail WCAG AA. The pane's ANSI palette keeps the
   **plain** steps, because that palette is what programs print with and must stay
   standard — `tests/tokens.test.ts` pins that they do not converge.
2. `blocked` and `conflict` are **filled**, because they are the states that need
   action now and because a wash fails for them: red text on a 20% red wash measures
   3.9:1. Filled measures 4.66:1.

## 4. Motion

Borrowed restraint: only `background-color`, `border-color` and `box-shadow`
transition; 90ms for hover/press, 140ms for selection and pane focus; standard easing,
**no overshoot, no transform, no scale**. Rail rows highlight **instantly** (no fade),
the way list rows do in the editor this material comes from. `prefers-reduced-motion`
switches every duration to ~0.

## 5. Accessibility rules

- Every text/background pair the UI paints is asserted ≥ 4.5:1 in
  `tests/tokens.test.ts` — including the six badge treatments, computed with the same
  arithmetic `color-mix()` performs.
- Keyboard focus uses a 1px `--cw-accent` outline, **deliberately overriding** the
  borrowed theme's own `focusBorder` (`#3e4452`), which is close to invisible. Mimicry
  does not get to win over focus visibility.
- No colour is the only carrier of meaning: badges carry a word, panes carry a name.

## 6. Guards (the part that keeps this true)

`apps/cockpit/tests/tokens.test.ts`:

1. every `var(--cw-*)` in `app.css` exists in `COCKPIT_TOKENS` (and there are >30, so
   the check cannot pass vacuously);
2. `app.css` contains **no** literal colour or colour function outside comments;
3. the pre-paint value in `index.html` equals `--cw-surface`;
4. the pane shares the chrome palette, and the terminal palette stays standard;
5. the mix weights in CSS equal the constants the contrast test measures;
6. no dimensional literal beyond that three-item structural allowlist;
7. all contrast assertions above.

## 7. Deliberately not done

- **Light theme.** `color-scheme: dark` only; the borrowed theme is dark.
- **Component library / CSS framework.** 388 lines of plain CSS with tokens is smaller
  than any dependency would be.
- **Mimicking Cursor's anatomy** (title bar, editor tabs, status bar) — see §1.
- **Motion beyond state changes.** No entrance animations, no layout animation, no
  scroll effects: this is a tool people keep open all day.
