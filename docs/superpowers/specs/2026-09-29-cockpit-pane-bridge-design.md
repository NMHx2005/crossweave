# Cockpit pane bridge — `cw pane`, a shell command that arranges the window

**Date:** 2026-09-29
**Status:** Planned (design taken in chat 2026-09-29 as tmux parity phase 2D)
**Scope:** `src/cli/commands/pane.ts` (new), `apps/cockpit/electron` (the `pane.*` kinds and a
renderer round trip), `apps/cockpit/src/ui` (the project view executes them), no daemon change, no schema.
**Branch:** `feat/pane-bridge`
**Builds on:** `2026-09-29-cockpit-command-bridge-design.md` (the daemon-side envelope) and
`2026-09-29-cockpit-tmux-parity-design.md` (2D).

## Problem

Layout lives in the cockpit's renderer, so the CLI cannot arrange panes: `tmux split-window` has no
`cw` equivalent, and neither does a script or a launcher that wants "open a shell beside this one". The
command bridge already carries a request from a shell command to the running cockpit; this uses it for
panes. Nothing about layout moves to the daemon (deferred until a second client exists).

## The threat this must survive

`daemon.sock` is reachable by **any process running as the user**, and one of those is an AI agent inside
a session that may have been **prompt-injected**. `CW_SESSION_ID` is in that agent's environment and is
trivially spoofable: it is a label, never a credential. So a `pane.*` request is **unauthenticated by
construction**, and what protects the person is what the cockpit agrees to do:

1. **A closed allowlist of kinds.** Nothing that types into a pane (no `send-keys`), reads a pane's
   output, kills a session, or runs a command. The most a request can do is arrange what is already there,
   open one more shell, or — after the person says yes — open a page or a file.
2. **Confirmation for what is not merely layout.** In the cockpit, in front of the person, by default:
   closing a pane, turning synchronize-panes on (typing then goes to several shells), opening a URL and
   opening a file. The dialog names the action and the target; it auto-denies before the CLI's own timeout.
3. **Visibility for the rest.** Every accepted request that changes the window shows a short toast ("A shell
   command split the pane"), so an agent cannot quietly rearrange the window.
4. **Bounds** from the bridge: 8 in flight, 20 a second, 8 MB, a timeout; and at most 20 panes in the window
   for `split`, so a loop cannot fill it.
5. **Strict parameter validation in the cockpit** (ids are opaque strings from `pane.list`, presets and
   directions are enums, URLs are http(s) only, file paths are relative to a named session's worktree and go
   through the existing containment check).

Residual risk, stated: a same-user process that registers first on the bridge (before the cockpit) can
observe these requests; the cockpit shows a notice when its registration is refused. An agent can still
`split` and `select` freely: it can already run any command, so opening one more shell gives it nothing it
did not have.

## Kinds (all in the `pane` namespace)

| Kind | Params | Does | Confirmation |
|---|---|---|---|
| `pane.ping` | – | proves the channel (already served) | no |
| `pane.list` | – | tabs and panes with opaque ids, kinds, which is focused | no |
| `pane.split` | `direction: right\|down`, `paneId?` | a new shell (terminal) in that pane's session, beside it | no (toast) |
| `pane.select` | `paneId` or `direction: left\|right\|up\|down` | moves focus | no |
| `pane.zoom` | `paneId?` | toggles zoom | no |
| `pane.layout` | `preset: even-horizontal\|even-vertical\|main-left\|tiled` | arranges the tab | no (toast) |
| `pane.move` | `paneId`, `tab: <tab id or 1-based index>` | moves the pane to another tab | no (toast) |
| `pane.sync` | `on\|off\|toggle` | synchronize-panes for the focused tab | **yes** to turn on; off needs none |
| `pane.close` | `paneId?` | closes the pane | **yes** |
| `pane.openUrl` | `url` | a Browser pane at an http(s) URL | **yes** |
| `pane.openFile` | `session`, `path` | a file pane on a file in that session's worktree | **yes** |

`pane.list` returns ids the cockpit made up for the window's current layout; a later request names them, and
one that no longer exists is `PANE_NOT_FOUND` — never a guess.

## Design

**Main process.** `commandBridge.serve(kind, handler)` for each kind. A handler does not act itself: it asks
the renderer, which owns the layout. `askRenderer(kind, params, ctx)` sends the event `bridge.request`
`{id, kind, params, projectRoot}` to the window and waits (at most 50 s) for the renderer's reply on a new
allow-listed channel `bridge.reply` `{id, ok, result | code, message}`. The pending map is keyed by an id main
made, so the renderer can only answer what main asked, once. No window (or no renderer that answers) is
`BRIDGE_NO_WINDOW`; the request is never queued for later.

**Renderer.** `App` routes the request to the `ProjectView` of `projectRoot` (whichever project is on the
stage, or another that is mounted). The view runs it with the same reducers the menu commands use
(`splitPane`, `closePane`, `toggleZoom`, `applyPreset`, `movePaneToTab`, `toggleSync`), validating every
parameter, asking for the confirmation where the table says so (`host.askConfirm`, `danger` for close) and
showing the toast. A request for a project that is not open is `PANE_NOT_FOUND`.

**CLI.** `cw pane list [--json] | split [right|down] | select <id|left|right|up|down> | zoom | layout <preset> |
move <paneId> <tab> | sync [on|off] | close [<id>] | open --url <url> | open --file <path> [--session <name>]`. It
calls the bridge with `timeoutMs` above the cockpit's confirmation (60 s vs 45 s), prints results as text (or
JSON), and the bridge's errors as the one `CODE: message` line.

## Errors

Bridge codes as before, plus `PANE_NOT_FOUND`, `PANE_INVALID` (a parameter that is not allowed),
`PANE_DENIED` (the person said no, or did not answer), `PANE_LIMIT` (too many panes), `BRIDGE_NO_WINDOW`.

## Testing

- `apps/cockpit/tests/pane-bridge.test.ts`: the pure request handler (`runPaneRequest`) over a stage: each kind's
  effect, validation (bad enum, unknown id, non-http URL, path traversal), the confirmation matrix (asked exactly
  where the table says, denied means unchanged), the pane cap, the toast text.
- `tests/cli/pane.test.ts`: argument parsing and the one-line error format.
- `apps/cockpit/tests/bridge-reply.test.ts`: main's pending map (answered once, only by its id, times out, no window).
- End to end on the running app: `cw pane list/split/select/layout/zoom/move` change the window; `close`,
  `sync on`, `open` wait for a confirmation and do nothing when it is refused (`scripts/pane-check.ts`).

## Risks

- **Confirmation fatigue**: only four kinds ask; the rest are layout. A person can also unregister nothing — there
  is no "always allow" in this version.
- **A hostile ordering of requests** (split until the cap, then select): bounded by the cap and by the bridge rates.
- **Stale ids** between `list` and a later call: answered `PANE_NOT_FOUND`, never a nearest match.

## Known limitations (to write at merge)

- No `send-keys`, no reading a pane's output, no session control: deliberately not offered.
- One cockpit per workspace; the first to register holds the slot; no headless use.
- No "always allow" for confirmed kinds; every use of them asks.
- The CLI cannot address a window other than the one registered for the project.
