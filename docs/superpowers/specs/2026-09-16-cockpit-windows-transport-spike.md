# Cockpit Windows control-plane spike

**Date:** 2026-09-16  
**Verdict:** `macOS-only-v1`  
**Code changed:** none (transport not implemented)

Windows cockpit packaging is out of this milestone. The daemon remains the sole agent owner; a thin Electron client cannot paper over a POSIX-only `cwd`.

---

## Verdict

**`macOS-only-v1` — Windows deferred until the daemon itself is ported.**

Do not implement `unix+named-pipe` or `loopback-tcp+token` now. A listen/connect path without a Windows-capable agent runtime would let later packaging tasks ship an installer that cannot attach or land.

Gate 1 of the brief is decisive: on the runtime this repo actually ships (`package.json` `engines.bun` `>=1.3.13`, local `bun` 1.3.14, `"os": ["darwin", "linux"]`), Bun does **not** support `ClaudePtyAdapter`'s `Bun.spawn({ terminal })` path on Windows. That API is POSIX-only until Bun 1.4.0.

Even after a Bun 1.4 bump, `cwd` is still not a Windows product this slice: unix-domain control plane, unix-domain MCP, `chmod` 0700/0600, `SIGTERM`/`SIGKILL`, `sh -c` land/converge, and M7 binaries/install that reject Windows. Those are a daemon port, not a cockpit transport patch.

Task 7 must ship **macOS arm64 only**. Do not produce a Windows x64 installer.

---

## 1. Does Bun on Windows support the daemon’s PTY adapter path?

**No — not on the Bun this repo pins and runs.**

### What the adapter needs

`ClaudePtyAdapter.spawn` (`src/adapters/claude-pty.ts`) is the pane path. It calls:

```ts
Bun.spawn([this.command, ...this.args, '--settings', radarHookSettings()], {
  cwd, env, terminal: { cols, rows, data(...) { wrapper?.emit(text); } },
});
```

and then uses `proc.terminal.write` / `resize` and `proc.kill`. Cockpit attach streams those bytes into xterm with no ANSI strip. If this spawn fails, there is no real pane.

Cursor/ACP (`src/adapters/acp.ts`) uses piped `node:child_process.spawn` (JSON-RPC, not a TTY). That might start on Windows, but it is not the interactive pane contract and it does not rescue Claude PTY.

### Evidence on current Bun (1.3.x)

| Fact | Source |
|---|---|
| This checkout: `bun` **1.3.14** | `bun --version` in the worktree |
| Declared floor | `package.json` `"engines": { "bun": ">=1.3.13" }` |
| Declared OS | `package.json` `"os": ["darwin", "linux"]` |
| `Bun.Terminal` introduced POSIX-only | [Bun v1.3.5](https://bun.com/blog/bun-v1.3.5): “Terminal support is only available on POSIX systems (Linux, macOS).” |
| Original product rule | `docs/superpowers/specs/2026-08-09-crossweave-design.md` §7: “Bun's pty support is POSIX-only… Windows is not a V1 target and will not be half-supported.” |

On 1.3.14, `Bun.spawn({ terminal })` is the same API the adapter already uses, and it is documented as unavailable on Windows. There is nothing to spike-implement in the adapter without a runtime bump plus a Windows runner.

### What changed later (out of this milestone)

Bun **1.4.0** (2026-08-20) added ConPTY: `Bun.Terminal` via `CreatePseudoConsole` ([PR #29522](https://github.com/oven-sh/bun/pull/29522), [Bun 1.4 notes](https://bun.com/blog/bun-v1.4)). Current docs ([child-process](https://bun.com/docs/runtime/child-process)) say core write/resize/data behavior matches POSIX, with Windows gaps:

- no termios / `setRawMode` is a no-op
- ConPTY **re-encodes** VT (semantically equivalent, not byte-identical; emits an init sequence)
- `\r` is not mapped to `\n`
- `SIGWINCH` in the child often does not fire
- before Windows 11 24H2, `terminal.close()` can block until conhost flushes — kill the child first

That is a future port input, not a reason to claim Win attach on 1.3.14.

### Verdict on question 1

**No.** Brief rule: if PTY is no → `macOS-only-v1`. Stop. Do not land transport code.

---

## 2. Can `node:net` listen on a named pipe or loopback TCP + token?

**Yes, either channel is implementable later.** Neither is sufficient this slice.

### Named pipe (`\\.\pipe\...`)

Node/`node:net` on Windows treats a `listen`/`connect` path of the form `\\.\pipe\<name>` as a named pipe (libuv `uv_pipe_t`). Bun’s Windows socket layer uses named pipes as the AF_UNIX stand-in.

Would work in principle:

```ts
const pipePath = `\\\\.\\pipe\\crossweave-${workspaceId}`;
server.listen(pipePath);
const sock = connect(pipePath);
```

Caveats if we ever do this:

- `chmodSync(socketPath, 0o600)` / `unlinkSync` / leftover-file `EADDRINUSE` recovery in `src/daemon/server.ts` are unix-socket file semantics. A pipe is not a file under `.crossweave/`. Live-vs-stale detection must change.
- Pipe ACL, not unix mode bits, is the access control.
- `mcpSocketPath` (`src/mcp/protocol.ts`) is a second unix socket (under `tmpdir()`, length-capped for AF_UNIX). Claude MCP would need the same pipe (or TCP) treatment, not just the daemon RPC socket.
- This spike was run on darwin. Named-pipe bind was **not** executed here.

### Loopback TCP + per-workspace token

Also implementable, and easier to test on macOS:

```ts
server.listen({ host: '127.0.0.1', port: 0 });
// write { port, token } to `.crossweave/daemon.lock` mode 0600
// first frame or first RPC must present the token; else drop
```

- Bind **only** `127.0.0.1` (not `0.0.0.0`).
- Token file under `.crossweave/` (owner-only). Reject connections that do not present it.
- Stale lock: connect + token probe, same spirit as today’s `isSocketLive`.
- **`connectOrStart` must keep unix `daemon.sock` on darwin/linux** (brief constraint). TCP would be `win32` only.

Auth is mandatory: loopback is still reachable from every local process.

### Which would we pick later?

Prefer **named pipe** (local-only, no port). Fall back to **loopback TCP + token** if pipe + Bun `node:net` misbehaves in a real Win runner. Do not open a remote port.

---

## 3. Minimal change set (documented, not applied)

If a later milestone ports the daemon (Bun ≥ 1.4, Windows runner, PTY + MCP + land/`sh` replacements), the control-plane delta is small and isolated:

| File | Change |
|---|---|
| `src/core/paths.ts` | `daemonEndpoint(projectRoot)` → unix path on posix; pipe name or lockfile path on win32 |
| `src/daemon/server.ts` | Branch `listen`: skip `chmod`/`unlink` file recovery on pipes/TCP; optional first-frame token check for TCP |
| `src/daemon/main.ts` | Print the actual endpoint; keep SIGINT; map SIGTERM to `SIGBREAK` / win shutdown if needed |
| `src/client/rpc-client.ts` | `DaemonClient.connect` accepts path **or** `{ host, port }` / pipe path; `connectOrStart` stays unix on darwin/linux |
| `src/mcp/protocol.ts` + `src/mcp/server.ts` | Same endpoint family as the daemon, or Claude MCP stays broken on Windows |
| Tests | `tests/daemon/transport-*.test.ts`: one round-trip (`ping` / `workspace.info`) on the new listen path |

That is a daemon-port slice, not a cockpit slice. No Electron UI depends on it for macOS v1.

---

## Remaining POSIX blockers (why transport alone is not a Win daemon)

These stay after any listen/connect patch:

1. **PTY** — 1.3.x missing; 1.4 ConPTY still not byte-identical (pane fidelity risk).
2. **MCP** — per-session unix sockets (`createMcpServer` / `mcpSocketPath`).
3. **Socket file perms** — `chmod` 0700 dir / 0600 sock; win32 needs ACLs or a token.
4. **Signals** — `runtime` stop/kill is `SIGTERM` then `SIGKILL`; ConPTY close-order caveat.
5. **Land / converge tests** — `Bun.spawn(['sh', '-c', testCommand])` in `land.ts` and `convergence-scheduler.ts`.
6. **Distribution** — M7 matrix is `darwin-arm64` / `darwin-x64` / `linux-x64`; `install.sh` errors on Windows (`docs/superpowers/specs/2026-08-14-m7-distribution-design.md`).
7. **npm `os` field** — install already refuses win32.
8. **Notifications** — darwin-only, already a no-op elsewhere (fine).
9. **No Windows runner in this spike** — any Win transport test here would be theoretical.

Cockpit v1 attach + land smoke on Windows is not reachable until 1–6 have an owner and a machine.

---

## Decision record

| Option | Taken? | Why |
|---|---|---|
| `unix+named-pipe` implemented now | No | PTY gate failed; pipe listen untested on Windows; MCP still unix |
| `loopback-tcp+token` implemented now | No | Same; would be dead code on darwin/linux and a fake Win claim |
| **`macOS-only-v1`** | **Yes** | Honest ship: macOS arm64 cockpit against the existing unix daemon |

### Follow-through

- Cockpit design updated: platforms v1 = macOS; Windows follows the daemon port.
- Plan Task 7: macOS arm64 only; skip Windows x64 nsis/portable.
- Revisit when: Bun ≥ 1.4 is the floor, `cwd` has a Windows job that runs PTY + MCP + land smoke, and `package.json` `"os"` / M7 artifacts include win32.

### What we did not do

- No daemon/client transport code.
- No new tests (no behavior change).
- No Electron UI (out of this task).
