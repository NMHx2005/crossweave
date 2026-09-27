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
| `--cw-surface-control-hover` | `#4b5363` | `button.hoverBackground` |
| `--cw-surface-overlay` | `#21252b` | `editorWidget.background` / `menu.background` — menus, popovers, dialogs, toasts |
| `--cw-shadow` / `--cw-scrim` | `#00000080` / `#0000004d` | `widget.shadow`; the dim layer under a dialog |
| `--cw-border-hover` | `#4e5666` | a field's border under the pointer |
| `--cw-accent-hover` / `--cw-danger-hover` | `#7dbdf3` / `#ff7a85` | primary / danger buttons, hovered |
| `--cw-surface-badge` | `#23272e` | `badge.background` |
| `--cw-border` | `#37393d` | `sideBar.border` |
| `--cw-border-strong` | `#3e4452` | `panel.border` |
| `--cw-text` | `#abb2bf` | `foreground` |
| `--cw-text-bright` | `#d7dae0` | `list.activeSelectionForeground` |
| `--cw-text-dim` | `#9da5b4` | `descriptionForeground` / `statusBar.foreground` |
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

## 4. Controls

One control layer at the top of `app.css` (added 2026-09-27; before it, components
styled their own — fifteen button and field variants, three field backgrounds, two
radii, push buttons with no hover state, the platform's light select arrow):

- **`.cockpit-btn`**, 26px (`--cw-control-h`, the editor's own control height), with
  `--primary`, `--danger`, `--ghost` and `--sm` (24px). Every state is defined: hover,
  active, disabled (dim label on the control surface, never lowered opacity — §6).
- **Fields** (`input`, `select`, `textarea` inside the shell) get one look from a
  zero-specificity `:where()` rule: input background, strong border, a lighter border
  on hover, the **accent border as the focus ring** (no second outline), a red border
  when `aria-invalid`. Selects draw their chevron from two gradient triangles in the
  text colour; checkboxes and radios are native, tinted with `accent-color`.
  `.cockpit-field--mono` is for what is typed like code (session names, branches,
  commands); display names stay in the UI font.
- **What floats** — context menus, popovers, dialogs, toasts — sits on
  `--cw-surface-overlay` with the widget shadow and the large radius; menu items are
  24px rows with their own radius, highlighted with the selection surface.

## 5. Motion

Borrowed restraint, revised 2026-09-27 at the user's request for motion that feels
like the editor's rather than none:

- Controls transition `background-color`, `border-color` and `color` over 90ms;
  selection and pane focus over 140ms; standard easing, **no overshoot, no scale**.
- **What appears fades in over 120ms (`--cw-dur-enter`) while travelling 4px
  (`--cw-lift`)**: menus and popovers drop from above, toasts rise from below,
  dialogs drop in over a fading scrim — the editor's context menu and quick input.
  Nothing animates on the way out: a dismissed menu is gone at once.
- The project twisty rotates over 140ms. Rail rows and menu items still highlight
  **instantly**, the way list rows do in the editor.
- No layout animation (a project folding open does not slide), no scroll effects.
- `prefers-reduced-motion` collapses every transition and animation to ~0.

## 6. Accessibility rules

- Every text/background pair the UI paints is asserted ≥ 4.5:1 in
  `tests/tokens.test.ts` — including the six badge treatments, computed with the same
  arithmetic `color-mix()` performs.
- Disabled controls are exempt from WCAG's contrast minimum, and the first version of
this system leaned on that exemption: `#4f5666` under `opacity: 0.6` on the control
surface measured **1.15:1**, which is not "quieter", it is unreadable — visible in the
screenshot of the packaged app as three blank buttons. Disabled labels now use
`--cw-text-dim` (3.77:1) with the muted background and a default cursor carrying the
affordance, and `tests/tokens.test.ts` asserts it, so nobody has to notice it by eye.

Keyboard focus uses a 1px `--cw-accent` outline, **deliberately overriding** the
  borrowed theme's own `focusBorder` (`#3e4452`), which is close to invisible. Mimicry
  does not get to win over focus visibility.
- No colour is the only carrier of meaning: badges carry a word, panes carry a name.

## 7. Guards (the part that keeps this true)

`apps/cockpit/tests/tokens.test.ts`:

1. every `var(--cw-*)` in `app.css` exists in `COCKPIT_TOKENS` (and there are >30, so
   the check cannot pass vacuously);
2. `app.css` contains **no** literal colour or colour function outside comments;
3. the pre-paint value in `index.html` equals `--cw-surface`;
4. the pane shares the chrome palette, and the terminal palette stays standard;
5. the mix weights in CSS equal the constants the contrast test measures;
6. no dimensional literal beyond that three-item structural allowlist;
7. all contrast assertions above.
8. the control layer's pairs: labels on every button state (resting and hovered
   primary/danger included), text on fields, and body/dim/danger text on the overlay.

## 8. Deliberately not done

- **Light theme.** `color-scheme: dark` only; the borrowed theme is dark.
- **Component library / CSS framework.** 388 lines of plain CSS with tokens is smaller
  than any dependency would be.
- **Mimicking Cursor's anatomy** (title bar, editor tabs, status bar) — see §1.
- **Motion beyond §5.** No exit animations, no layout animation, no scroll effects:
  this is a tool people keep open all day.
- **Custom-drawn checkboxes.** Chromium draws no `::after` on a checkbox, so a custom
  one needs extra markup at every use; the native one tinted with `accent-color` is
  the editor-like result for none of that.
