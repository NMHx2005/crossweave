# Cockpit command bridge — the daemon asks the running cockpit to do something

**Date:** 2026-09-29
**Status:** Planned (design approved in chat 2026-09-29)
**Scope:** `src/daemon` (a bridge registry + two RPC methods), `src/cli` (a generic
`bridge.call` helper), `apps/cockpit/electron` (`daemon-bridge.ts`, `channels.ts`), no
schema, no migration.
**Branch:** `feat/command-bridge`
**Consumers:** `cw browser` (`2026-09-29-cockpit-browser-agent-access-design.md`) and the
tmux-parity phase 2D `cw pane` (`2026-09-29-cockpit-tmux-parity-design.md`).

## Problem

The daemon can only *push* to a client: `MethodContext.notify(method, params)` is one-way
(`src/daemon/server.ts:12-15`) and the cockpit answers nothing back. Two planned features
need the opposite direction — a shell command (`cw pane split`, `cw browser console`)
must make the **running cockpit** act and return a result. Building that request/response
channel once, here, keeps `cw pane` and `cw browser` from each inventing their own.

The daemon stays the sole owner of state and the only thing a shell can reach (the unix
socket, directory `0700`, socket `0600` — `server.ts:148-151,217`). The cockpit stays a
thin client: it does not listen on anything.

## Goals / non-goals

**Goals**
- A daemon method a CLI calls with `{kind, params}` that is delivered to the cockpit
  attached to that workspace and answered with a result or a typed error.
- Bounded: timeouts, payload caps, concurrency cap, no orphaned waiters.
- A closed set of request kinds; the daemon forwards, the cockpit decides.

**Non-goals**
- Any authentication of the caller. Every process running as the user can reach the
  socket, including an agent in a session; `CW_SESSION_ID` in the environment is
  spoofable and is **never** a credential. Authorisation is the cockpit's job, per kind.
- Persisting anything. No table, no ledger event, nothing survives a daemon restart.
- Daemon-owned layout, or any headless behaviour: with no cockpit attached the bridge
  answers `BRIDGE_NO_COCKPIT`.

## Design

### Roles

- **Cockpit main process** (`DaemonBridge`, already a `DaemonClient` — `daemon-bridge.ts`)
  registers itself for a workspace and serves requests.
- **Daemon** keeps an in-memory `BridgeRegistry`: `workspaceId → Registration`, where a
  registration is `{ctx, kinds, pending: Map<id, Waiter>}`.
- **CLI** (or any client) calls `bridge.call`.

### Wire

| Direction | Method / notification | Payload |
|---|---|---|
| cockpit → daemon | `bridge.register` (request) | `{workspaceId, kinds: string[]}` — the request kinds this cockpit serves |
| daemon → cockpit | `bridge.request` (notification) | `{id, kind, params}` |
| cockpit → daemon | `bridge.respond` (request) | `{id, ok: true, result}` or `{id, ok: false, code, message}` |
| CLI → daemon | `bridge.call` (request) | `{workspaceId, kind, params, timeoutMs?}` → the result, or a `CrossweaveError` |

`id` is a daemon-generated random id, never chosen by a client, so a cockpit can only
answer a request the daemon actually issued to it.

### Rules

- **Closed kinds.** A kind is `<namespace>.<verb>` and its namespace must be on the
  daemon's list (`pane`, `browser` for now; adding a namespace is a **daemon change**, not
  something a client can do). `bridge.call` for an unknown namespace →
  `BRIDGE_UNKNOWN_KIND` before anything is sent.
- **Only kinds the cockpit registered.** A namespace on the list is not enough: the kind
  must be in the live registration's `kinds`, else `BRIDGE_UNSUPPORTED_KIND` (not a
  confusing timeout or handler failure). A cockpit may register only kinds inside the
  daemon's list.
- **One registration per workspace, first come first served.** While a registration is
  live, a second `bridge.register` is **refused** with `BRIDGE_ALREADY_REGISTERED`; it
  never replaces the live one. A registration ends only when its `ctx` closes (cockpit
  quit, daemon restart), and the cockpit re-registers on reconnect. "Newest wins" was
  rejected: any process running as the user could register and take the live cockpit's
  place, receive its requests, forge its answers, or starve it. A cockpit that finds the
  slot taken shows a notice ("another client is registered on this workspace"). No
  multi-window fan-out; a window selector is a later concern.
- **Detach.** `ctx.onClose` removes the registration and rejects every pending waiter
  with `BRIDGE_DETACHED` — a waiter never outlives its cockpit.
- **Timeout.** The caller passes `timeoutMs`; default 10 s, floor 1 s, ceiling 60 s (out
  of range is clamped — `0` is never "wait forever"). A kind that waits on a person
  (a confirmation) is called with a longer value by its own CLI command; the confirm
  timeout of a kind must stay **below** the timeout its CLI passes. On expiry the waiter
  is removed and the caller gets `BRIDGE_TIMEOUT`. A late `bridge.respond` for a removed
  id is ignored, silently.
- **Caps.** At most 8 in-flight requests per registration (`BRIDGE_BUSY` beyond that) and
  at most 20 `bridge.call` per second per registration; `params` and a response each
  capped at 8 MB (`BRIDGE_TOO_LARGE`; the socket frame limit is 16 MB,
  `src/core/framing.ts:15`). **Binary results (screenshots) do not travel over the
  bridge:** the cockpit writes the file and returns its path.
- **Exactly-once response.** The first `bridge.respond` for an id settles the waiter;
  any other is ignored.
- **The daemon does not interpret `params` or `result`.** It validates the envelope only.
  Whatever a kind means, and who may ask for it, is decided in the cockpit.

### Cockpit side

The bridge itself adds no renderer-facing channel: it is main-process only. (A kind may
add its own; `browser.*` does — see its spec.) A kind's handler is registered with
`bridge.serve(kind, handler)`; a handler that throws a `CrossweaveError` produces
`{ok:false, code, message}`, anything else a generic `BRIDGE_HANDLER_FAILED` (no stack, no
internals — fail closed).

**Delivery point.** `DaemonBridge` holds one client per open project and forwards each
notification through `forward(method, params, projectRoot)` (`daemon-bridge.ts:210-213`).
`bridge.request` is intercepted **before** `forward`, in the main process, and handled for
the workspace whose client received it — whichever project is on the stage. It is never
sent to the renderer. Registration is per project client: each project's `bridge.register`
runs when that project attaches.

### Errors (`CrossweaveError` codes)

`BRIDGE_NO_COCKPIT`, `BRIDGE_UNKNOWN_KIND`, `BRIDGE_DETACHED`, `BRIDGE_TIMEOUT`,
`BRIDGE_BUSY`, `BRIDGE_TOO_LARGE`, `BRIDGE_HANDLER_FAILED`, `BRIDGE_ALREADY_REGISTERED`,
`BRIDGE_UNSUPPORTED_KIND`. The CLI prints exactly one
`CODE: message` line as everywhere else.

## Security

- The caller is unauthenticated by design; the daemon socket is the boundary (same-user
  only). A prompt-injected agent in a session **can** issue `bridge.call`. Therefore the
  bridge grants nothing by itself: each kind's handler in the cockpit enforces its own
  permission (for `browser`, the per-pane switch and origin rules).
- **Integrity and availability are not protected against the same user.** Any process
  running as the user can `bridge.register` first (the daemon is auto-started by whichever
  client connects first, so no spawn-time secret can be trusted) and then receive requests
  and forge results, or make the real cockpit's register fail. First-come-first-served plus
  the cockpit's visible notice narrows the window and makes it noticeable; it does not
  close it. This is stated as a residual risk, not a property of the bridge.
- `id` unforgeability and one-response-per-id stop a second client from answering another
  client's request; only the registered `ctx` may respond, checked against the
  registration that received the request.
- No new listener: the bridge rides the existing unix socket.

## Testing

`tests/daemon/command-bridge.test.ts`, all with a fake cockpit `ctx` (no socket, no pty):
call with no cockpit → `BRIDGE_NO_COCKPIT`; round trip; unknown namespace; a kind in
a known namespace that the cockpit did not register → `BRIDGE_UNSUPPORTED_KIND`; timeout
removes the waiter and a late response is ignored; `timeoutMs` 0/negative/huge is
clamped; ctx close rejects pending with `BRIDGE_DETACHED` and frees the slot; **a second
register while one is live is refused and the first keeps working**; re-register after
close succeeds; the in-flight cap and the rate cap; the payload cap; a `respond` from a ctx that was not the addressee is
ignored; the first `respond` wins. `tests/cli/bridge.test.ts` for the one-line error
format. Cockpit `serve` wrapper: a throwing handler yields `BRIDGE_HANDLER_FAILED` with
no message leakage.

## Risks

- **Waiter leaks** — mitigated by timeout and detach both clearing the map; the
  test asserts the map is empty after each.
- **Head-of-line blocking** on a slow handler — the in-flight cap bounds it; handlers
  that need a human (a confirmation dialog) must finish within the timeout or be denied.

## Known limitations (to write at merge)

- One cockpit per workspace; the first to register holds the slot.
- No headless operation.
- Caller identity is not authenticated; safety rests on per-kind checks in the cockpit.
- A same-user process that registers first can observe requests and forge answers
  (residual risk above).
