/**
 * Cockpit design tokens — the single source of truth for BOTH the CSS chrome and
 * the xterm palette, so the pane can never drift from the frame around it.
 *
 * Provenance, stated plainly because this is borrowed material rather than an
 * official system: Cursor publishes no design system of its own, so the vocabulary
 * here is VS Code's workbench role names and the values are read straight out of
 * the theme this repo is developed in — Cursor + "One Dark Pro Night Flat"
 * (zhuangtongfa.material-theme):
 *
 *   sideBar.background            -> --cw-surface
 *   input.background              -> --cw-surface-input
 *   list.hoverBackground          -> --cw-surface-hover
 *   list.focusBackground          -> --cw-surface-active
 *   button.background             -> --cw-surface-control
 *   button.hoverBackground        -> --cw-surface-control-hover
 *   editorWidget.background / menu.background
 *                                 -> --cw-surface-overlay (menus, popovers, dialogs, toasts)
 *   widget.shadow                 -> --cw-shadow
 *   input.border (hover)          -> --cw-border-hover
 *   badge.background              -> --cw-surface-badge
 *   sideBar.border                -> --cw-border
 *   panel.border                  -> --cw-border-strong
 *   foreground / list.activeSelectionForeground / descriptionForeground
 *                                 -> the three text steps
 *   textLink.foreground           -> --cw-accent
 *   editorCursor.foreground       -> --cw-cursor
 *   editor.selectionBackground    -> --cw-selection
 *   scrollbarSlider.background    -> --cw-scrollbar(+hover)
 *
 * What is deliberately NOT borrowed: Cursor's layout and anatomy — the rail, the
 * stage and the footer stay crossweave's own, because landability and the attention
 * rail are what this product has that an editor does not — plus its logo and fonts.
 *
 * The five attention/landability roles have no counterpart in an editor theme, so
 * instead of inventing hues they come from the same theme's terminal palette. Two
 * deliberate choices there, both measured by tests/tokens.test.ts rather than
 * eyeballed:
 *
 *  1. Roles use the BRIGHT steps of that palette, not the plain ones: as 11px badge
 *     text over their own tinted badge, the plain steps land at ~4.0:1 and fail
 *     WCAG AA. The pane's ANSI palette below keeps the PLAIN steps, because that
 *     palette is what programs print with and must stay standard.
 *  2. `blocked` and `conflict` are FILLED (dark text on the hue) rather than washed.
 *     The two states that need action now earn the visual weight, and they are the
 *     ones a wash would fail on: red text on a 20% red wash measures 3.9:1.
 */

export const COCKPIT_TOKENS = {
  // Surfaces. "Night Flat" is flat on purpose: one surface, not an elevation ramp.
  '--cw-surface': '#16191d',
  '--cw-surface-input': '#1d1f23',
  '--cw-surface-hover': '#2c313a',
  '--cw-surface-active': '#323842',
  '--cw-surface-control': '#404754',
  '--cw-surface-control-hover': '#4b5363',
  // What floats above the chrome — menus, popovers, dialogs, toasts — is one step
  // lighter and casts the theme's widget shadow, as the editor's own widgets do.
  '--cw-surface-overlay': '#21252b',
  '--cw-shadow': '#00000080',
  // The dim layer under a dialog: the stage stays visible, the dialog is the focus.
  '--cw-scrim': '#0000004d',
  '--cw-surface-badge': '#23272e',
  // The sidebar sits one step above the stage, as in Deck: the rail reads as a place,
  // the stage as the work.
  '--cw-surface-sidebar': '#1e2126',

  '--cw-border': '#37393d',
  '--cw-border-strong': '#3e4452',
  '--cw-border-hover': '#4e5666',

  // Text, brightest to dimmest. Nothing dimmer than --cw-text-dim is allowed to
  // carry words at this size: the theme's comment colour is 2.5:1 on a badge.
  '--cw-text': '#abb2bf',
  '--cw-text-bright': '#d7dae0',
  '--cw-text-dim': '#9da5b4',

  '--cw-accent': '#61afef',
  // Primary and danger buttons lighten one step on hover, like button.hoverBackground.
  '--cw-accent-hover': '#7dbdf3',
  '--cw-danger-hover': '#ff7a85',
  '--cw-cursor': '#528bff',
  '--cw-selection': '#67769660',

  // Attention / landability roles — the theme's bright ANSI steps.
  '--cw-working': '#4dc4ff',
  '--cw-ready': '#a5e075',
  '--cw-needs-you': '#f0a45d',
  // Was #ff616e: 4.0:1 as a danger menu item's text on the hovered row (Kill…,
  // Close project) — caught once every theme ran the same checks. One step lighter.
  '--cw-blocked': '#ff7580',
  '--cw-conflict': '#de73ff',

  // Agent marks on the rail and tabs: each CLI's own hue, used for a glyph only.
  '--cw-agent-claude': '#d97757',
  '--cw-agent-codex': '#d7dae0',
  '--cw-agent-gemini': '#8ab4f8',
  '--cw-agent-opencode': '#c3c8d0',
  '--cw-agent-antigravity': '#7aa2ff',
  '--cw-agent-cursor': '#abb2bf',
  '--cw-agent-copilot': '#c49bff',
  '--cw-agent-aider': '#7ee2a8',
  '--cw-agent-amp': '#ffb86b',
  '--cw-agent-qwen': '#7c8cff',

  '--cw-scrollbar': '#4e5666',
  '--cw-scrollbar-hover': '#5a6375',

  // Density and geometry: the numbers that make an editor chrome read as compact.
  '--cw-font-ui': "'SF Pro Text', system-ui, -apple-system, sans-serif",
  '--cw-font-mono': "Menlo, Monaco, 'Courier New', monospace",
  '--cw-fs-micro': '11px',
  '--cw-fs-sm': '12px',
  '--cw-fs': '13px',
  // The rail's rows and project names: Deck-sized, read at a glance, not scanned.
  '--cw-fs-rail': '14px',
  '--cw-fs-project': '15px',
  // Structural dimension, one place: 1px borders, focus outline width, the row
  // separators and the meta gap all read as the same hairline rhythm.
  '--cw-hairline': '1px',
  '--cw-bar-w': '2px', // the selection bar inside a focused rail row
  '--cw-control-pad-y': '2px', // vertical padding shared by buttons and selects
  // Every push button and every field is this tall: 26px is the editor's own input
  // and button height, so a dialog reads like the editor's widgets.
  '--cw-control-h': '26px',
  '--cw-check': '14px', // checkbox and radio size
  '--cw-chevron': '4px', // the select's drawn chevron (two 4px triangles)
  '--cw-tracking-label': '0.08em', // the uppercase micro labels' letter-spacing
  '--cw-scrollbar-w': '10px',
  '--cw-scrollbar-inset': '2px', // transparent border that insets the thumb
  '--cw-radius-sm': '3px',
  '--cw-radius': '5px',
  '--cw-radius-lg': '7px',
  '--cw-space-1': '4px',
  '--cw-space-2': '6px',
  '--cw-space-3': '10px',
  '--cw-space-4': '14px',
  '--cw-rail-w': '280px',
  '--cw-row-h': '24px',
  '--cw-rail-row-h': '34px',
  // Room the hidden-inset title bar leaves for the traffic lights.
  '--cw-titlebar-h': '44px',
  '--cw-traffic-w': '78px',

  // Motion. Controls move background and border only, over ~0.1s, without overshoot.
  // What appears and goes away — menus, popovers, dialogs, toasts — fades in over
  // 120ms while travelling `--cw-lift`, as the editor's context menus and quick input
  // do; rows and tabs still change instantly. Reduced motion collapses all of it.
  '--cw-dur-fast': '90ms',
  '--cw-dur': '140ms',
  '--cw-dur-enter': '120ms',
  '--cw-lift': '4px',
  // One turn of the working ring: slow enough to read as "busy", not as an alarm.
  '--cw-dur-spin': '1600ms',
  '--cw-ease': 'cubic-bezier(0.2, 0, 0.2, 1)',
  // Structure moving (a pane splitting, closing or changing place). Longer than a control's
  // hover but still under a quarter second, so a layout change never makes anyone wait.
  '--cw-dur-layout': '180ms',
  // Whole-view fades (a tab or project switching): the slowest thing the cockpit does.
  '--cw-dur-slow': '220ms',
  // Decelerates into place: a pane arriving should settle, not stop dead.
  '--cw-ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  // A small overshoot for something that lands (the attention pulse), as a CSS spring.
  '--cw-ease-spring': 'linear(0, 0.55 12%, 0.98 30%, 1.04 42%, 1.01 60%, 1)',
} as const

export type CockpitTokenName = keyof typeof COCKPIT_TOKENS

/**
 * The pane's terminal palette: the same theme's PLAIN ANSI steps, so an agent's TUI
 * prints the colours it would print in that editor's terminal. Only the four values
 * that describe the pane itself are shared with the chrome tokens above.
 */
export const XTERM_THEME = {
  background: COCKPIT_TOKENS['--cw-surface'],
  foreground: COCKPIT_TOKENS['--cw-text'],
  cursor: COCKPIT_TOKENS['--cw-cursor'],
  cursorAccent: COCKPIT_TOKENS['--cw-surface'],
  selectionBackground: COCKPIT_TOKENS['--cw-selection'],
  black: '#3f4451',
  red: '#e05561',
  green: '#8cc265',
  yellow: '#d18f52',
  blue: '#4aa5f0',
  magenta: '#c162de',
  cyan: '#42b3c2',
  white: '#d7dae0',
  brightBlack: '#4f5666',
  brightRed: '#ff616e',
  brightGreen: '#a5e075',
  brightYellow: '#f0a45d',
  brightBlue: '#4dc4ff',
  brightMagenta: '#de73ff',
  brightCyan: '#4cd1e0',
  brightWhite: '#e6e6e6',
} as const

export const XTERM_FONT_FAMILY = COCKPIT_TOKENS['--cw-font-mono']
export const XTERM_FONT_SIZE = 13

/** How strongly a badge washes its hue over the badge surface. Tests reuse these. */
export const BADGE_WASH = 0.16
/** The filled treatment `blocked`/`conflict` use instead. */
export const BADGE_FILL = 0.85

/**
 * Publish the tokens as CSS custom properties. Runtime injection rather than a
 * second hand-maintained stylesheet is the whole point: with one source, a colour
 * can no longer exist in the CSS but not in the palette (or the reverse).
 * `index.html` carries one literal --cw-surface value for the frame before this
 * runs; tests/tokens.test.ts fails if the two disagree.
 */
export function applyTokens(root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(COCKPIT_TOKENS)) {
    root.style.setProperty(name, value)
  }
  root.style.colorScheme = 'dark'
}
