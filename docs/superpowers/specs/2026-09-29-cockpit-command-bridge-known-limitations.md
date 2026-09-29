# Cockpit command bridge — known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-command-bridge-design.md` · Plan:
`../plans/2026-09-29-command-bridge.md` · Branch `feat/command-bridge`

## What shipped

A shell command can make the running cockpit do something and get an answer, through the
project's daemon: `bridge.call` (from the CLI) → `bridge.request` (to the cockpit) →
`bridge.respond`. The daemon carries the envelope and interprets nothing inside it
(`src/daemon/bridge-registry.ts`); the cockpit's main process serves the kinds
(`electron/command-bridge.ts`) and never shows a request to the window. `src/cli/bridge-call.ts`
is the helper `cw pane` and `cw browser` will build on. Only `pane.ping` is served so far.

Verified on the real app: a client's `pane.ping` is answered by Electron with its project root; a
kind the cockpit does not serve is `BRIDGE_UNSUPPORTED_KIND`; a namespace outside the daemon's
list is `BRIDGE_UNKNOWN_KIND`; a second client cannot take the slot and the cockpit keeps
answering (`apps/cockpit/scripts/bridge-check.ts`).

## Limitations

- **One cockpit per workspace; the first to register holds the slot.** No fan-out to several
  windows. A cockpit that finds the slot taken shows a notice.
- **No headless operation:** with no cockpit attached every call is `BRIDGE_NO_COCKPIT`.
- **The caller is not authenticated.** Anything running as the user reaches the socket, an agent in
  a session included; `CW_SESSION_ID` is spoofable and is never a credential. Safety rests on the
  per-kind checks in the cockpit, which do not exist yet beyond `pane.ping`.
- **Residual risk, same user:** a process that registers first can watch requests and forge answers,
  or make the real cockpit's register fail. First-come-first-served plus the visible notice narrows
  and exposes it; it does not close it.
- **A daemon older than the app has no bridge.** The cockpit treats the missing method as "feature
  absent" and says nothing; the daemon must be restarted (which ends its sessions) to gain it.
- **The rate cap answers `BRIDGE_BUSY`** (the spec gave no separate code for the 20-a-second limit).
- **Nothing persists:** no table, no ledger event; a daemon restart forgets every registration.
- **Binary results do not travel** (8 MB cap on params and on a response); a kind that produces one
  writes a file and returns its path.
