# tmux parity 2B — key-table: known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-tmux-parity-design.md` · Branch `feat/tmux-keytable`

## What shipped

- **The prefix** (`Ctrl+A` by default, the command "Prefix Key" in Settings → Keyboard, rebindable and
  unbindable) then **one key** runs a command: `%` split right, `"` split down, `z` zoom, arrows focus,
  `o` swap, `x` close, `[` copy-mode, `c` new session, `n`/`p` next/previous tab, `Space` cycle layout,
  `:` command bar, `?` shortcuts, `!` break pane, `s` synchronize panes (`lib/keytable.ts`, pure, tested).
- **A hint** listing the table appears while the prefix is held and goes on Esc, on a key, or after 3 s.
  **The prefix twice types the literal Ctrl-a** into the pane that has the keyboard.
- **Scope:** it acts only while xterm's own input inside a pane has the keyboard — never the find box,
  Settings, a note editor or any input; IME composition is never intercepted; bare modifiers are ignored.
- **The recorder** in Settings → Keyboard: pressing the prefix while recording a command's shortcut waits for
  one more key and stores `prefix:<key>`; conflicts are checked; the daemon validates the form.
- Verified on the running app: the hint, prefix `%` splits, prefix twice typed Ctrl-a (a line typed as
  `echo abc` ran as `Xecho abc`), prefix `z` zooms, an unbound key leaves prefix mode, and no interception in
  the sidebar's filter box. The check found a real bug — the literal was sent to the layout-focused pane, not
  the one holding the keyboard — now fixed.

## Limitations

- **Ctrl-a is beginning-of-line in a shell**, and it is the default prefix by decision. In a terminal pane a
  single Ctrl-a is now the prefix; press it twice for the line-start key, or rebind or unbind the prefix under
  Keyboard (unbound: no key-table, nothing is intercepted).
- **The literal exists only for a `Ctrl+<letter>` prefix**; another prefix has no byte to type twice.
- **One level:** the prefix and one key. No nested tables, no repeat mode (tmux's `-r`), no copy-mode's own table.
- **The recorder records "prefix, then a key"**, not arbitrary two-chord sequences. Unbinding a command's
  accelerator leaves its default key-table key; rebinding it to another `prefix:<key>` replaces it.
- **A daemon older than the app refuses a `prefix:` binding** (its validation predates it): the settings page shows
  "Not saved — …" until that project's daemon is restarted.
- **IME behaviour is unit-tested and, since 2026-09-30, exercised on the running app with Chromium's IME simulation**
  (`apps/cockpit/scripts/ime-check.ts`: `Input.imeSetComposition` + `Input.insertText` build "tiếng", "ắ", "đ", "ô", "ư" in a terminal pane;
  a composing key after the prefix runs no command, ends prefix mode and its text still arrives). That simulates the browser's composition
  events, **not macOS's Vietnamese input source**: it was still not typed on a real Telex keyboard, and a person should try one line of
  Vietnamese with the prefix held before relying on it.
- The hint is a fixed three-column list; a table with many user additions may become long.
