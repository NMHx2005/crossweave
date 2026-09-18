# The client seam, and what remote would take

**Date:** 2026-09-18
**Status:** seam built (`src/client/transport.ts`); remote is designed, not built.
**Scope:** how a client reaches the daemon, and the honest cost of reaching it from
somewhere other than this machine.

---

## 1. What was true before

Every client — CLI, TUI, Cockpit — is a thin JSON-RPC client over one daemon that owns
the state (`docs/superpowers/specs/2026-08-09-crossweave-design.md` §5.2). That was the
right call from M0, and it is why remote is a transport change rather than a rewrite.

But `DaemonClient` was constructed around a `node:net` `Socket`, so "another transport"
meant forking the client. The protocol was already portable — `encodeFrame` and
`createLineFramer` are byte-stream code, not socket code — so the socket dependency was
an accident of history, not a design.

## 2. The seam

`src/client/transport.ts` defines `ClientTransport`: `write`, `onData`, `onEnd`,
`onError`, `onClose`, `isWritable`, `close`. That is the whole surface `DaemonClient`
needs, and it is typed after what a WebSocket already gives you.

`DaemonClient.connect(path)` builds the unix-socket one; `DaemonClient.attach(transport)`
takes any other. Everything above the seam — request multiplexing, the pending map,
notification fan-out, fail-fast on half-close — is transport-independent and tested over
an in-memory transport (`tests/client/transport.test.ts`), which is what makes the claim
checkable rather than aspirational.

Two details are load-bearing and easy to lose in a re-implementation:

- **`onEnd` is not `onClose`.** When the peer half-closes but a write is still buffered,
  neither `close` nor `error` fires, so `onEnd` is the only signal that a pending
  response can never arrive. Without it a call hangs forever instead of failing.
- **Listeners are attached by the transport at construction,** not by each subscriber
  afterwards. A Node EventEmitter with no `'error'` listener throws, and the gap between
  "connected" and "subscribed" is exactly when that happens.

## 3. What remote actually costs

The seam is the cheap part. The expensive part is that **crossweave has no auth boundary
today, deliberately**: the trust boundary is the OS user account, enforced by file
permissions (socket `0600`, `.crossweave/` `0700`), with no network listener and no
token. Anyone who can open the socket owns everything — it spawns processes, writes
files and holds every session's context on that user's behalf.

So "control my sessions from my laptop/phone" changes what "anyone who can open the
socket" means, and that is the whole job. Non-negotiable before a network listener:

- authentication (per-workspace token at minimum) and **authorization** — watching a pane
  is not the same right as sending input, and neither is the same as `land`;
- transport encryption, or an explicitly trusted private network;
- revocation, and an audit trail of who did what.

**Do not** expose the existing no-auth socket over TCP. That is the one version of this
change that turns a design decision into a vulnerability.

## 4. Staged path

| Stage | What | Why this order |
|---|---|---|
| 0 | **Gateway**: a process that speaks JSON-RPC to the unix socket on one side and WebSocket on the other, reusing the Cockpit's closed channel allowlist as the shape | Proves the whole flow with no change to the daemon, and the daemon stays local |
| 1 | **Auth**: token per workspace, TLS, read-vs-control split, revocation | The gate on everything after it |
| 2 | **Clients**: web pane (xterm.js — the Cockpit already proves the rendering half), notifications through the existing `notify` seam | Reuses the seam and the shared token layer |
| 3 | **Multi-machine / hosted relay** | Agents and code on someone else's infrastructure — a different trust question, deliberately deferred |

`cwd` is POSIX-only (unix sockets, `chmod`, signals, `sh -c`) and Bun's pty is
POSIX-only, so whatever the client is, the daemon stays on macOS or Linux.

## 5. Where the app entry point fits

Bare `cw` now opens the interactive dashboard (`src/cli/entry-mode.ts`) when it has a
terminal, and keeps printing help when it does not — a full-screen renderer in a pipe is
garbage in a log, and the caller that most needs the help text is the one with no TTY.

The Electron Cockpit is the richer client, and on macOS it should become what bare `cw`
opens. That waits on packaging (the installer has to be resolvable from an installed
binary), which is the same work that puts the Cockpit into a release. Until then the
dashboard is the app, everywhere, predictably.
