# Cockpit pane bridge (`cw pane`) — known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-pane-bridge-design.md` · Plan: `../plans/2026-09-29-pane-bridge.md` · Branch `feat/pane-bridge`

## What shipped

`cw pane list | split | select | zoom | layout | move | sync | close | open` arranges the running cockpit window
through the command bridge. The main process forwards each `pane.*` kind to the window
(`electron/renderer-bridge.ts`: an id main makes, answered once on `bridge.reply`, 50 s, `BRIDGE_NO_WINDOW`), which
runs it against the project's layout with `runPaneRequest` (`src/lib/pane-bridge.ts`, pure and tested) and answers.

**The security matrix** (the caller is unauthenticated: any process of the user, an injected agent included):

| Kind | Effect | Asks the person? | Visible? |
|---|---|---|---|
| `list` | reads ids, kinds, session names | no | no |
| `split` | a new shell in that pane's session | no | toast |
| `select`, `zoom` | focus / zoom | no | no |
| `layout`, `move` | arranges panes | no | toast |
| `sync` on | typing goes to several shells | **yes** | toast |
| `sync` off | back to normal | no | – |
| `close` | closes a pane (danger dialog) | **yes** | – |
| `open --url` | a Browser pane (http/https only) | **yes**, names the URL | – |
| `open --file` | a file pane (relative path, in a named session) | **yes**, names both | – |

Not offered at all: typing into a pane, reading its output, killing or starting sessions, running a command. No
answer within 45 s, a dismissed dialog, or a dialog that fails is a **refusal** (`PANE_DENIED`), never an approval.
Invalid requests (bad enum, unknown id, `file:`/`javascript:` URLs, `..`/absolute/`~` paths, more than 20 panes) are
refused before the person is ever asked. When the person did say yes, the change is applied to the layout **as it is
then**, not as it was when the dialog opened.

Verified on the running app (`apps/cockpit/scripts/pane-check.ts`): list, split (no dialog, a toast), layout, select,
zoom; a bad preset, an unknown pane, a `file:` URL and a path leaving the worktree are refused and never show a
dialog; `close`, `sync on` and `open --url` wait for the person, name what they will do, and change nothing when
refused or dismissed; allowing closes the pane.

## Limitations

- **The socket is the boundary, not authentication.** An agent in a session can issue `split`, `select`, `zoom`,
  `layout`, `move` and `list` without asking; it could already run any command, so an extra shell gives it nothing new.
  It can also learn the layout and session names (`list`).
- **A same-user process that registers on the bridge first** can watch these requests and forge answers; the
  cockpit shows a notice when its own registration is refused (see the command bridge's limitations).
- **Every use of a confirmed kind asks:** there is no "always allow" and no allow-list of hosts or paths.
- **One cockpit per workspace, no headless use:** with no window, `BRIDGE_NO_WINDOW`; a project not open in the
  window is `PANE_NOT_FOUND`.
- **Pane ids are the window's layout ids**, valid until the layout changes: a stale id is `PANE_NOT_FOUND`.
- **`split` opens a shell only** (not a session or a browser); `open` reaches a browser or file pane only after a yes.
- **The 20-pane cap is per window** across all tabs, and a full window refuses `split` and `open`.
- **The CLI's confirm-kind timeout (60 s) is fixed**; a person who takes longer gets `PANE_DENIED`.
