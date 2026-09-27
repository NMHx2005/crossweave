# Remote / phone access — design

**Date:** 2026-09-27
**Status:** Approved (decisions below were the user's, 2026-09-27)
**Plan:** `docs/superpowers/plans/2026-09-27-remote-phone.md`

## Goal

From a phone, like Claude Code's Remote Control: see every project open in the
cockpit, its sessions (status, the agent's last words, cost), watch one session live,
answer it (type, Enter / Esc / Ctrl-C / y / n / ↑ ↓), and start a new session with one
of the launchers configured on the Mac — without exposing the Mac to anyone else.

## Decisions

| Question | Decision |
|---|---|
| Reach | **Both**: the Tailscale address (encrypted by WireGuard, works away from home) and the same Wi-Fi (HTTPS). Each one on/off in Settings. Never `0.0.0.0`, no relay, no port forwarding. |
| What a paired phone may do | **Full control of a session, like Claude's Remote Control**: watch, type, start a session with a configured launcher, set a note. **Not** remotely: kill, delete, land, gc, arbitrary commands (`run`/`env`), reading files. |
| When it runs | **With the cockpit, once turned on** in Settings → Remote; off = the server process is gone and every phone is disconnected. |

## Shape

```
phone browser ──HTTPS (Wi-Fi) / HTTP over Tailscale──▶ remote server (cwd remote)
                                                          │  one DaemonClient per project
                                                          ▼
                                              <root>/.crossweave/daemon.sock (each open project)
cockpit main ──stdio JSON lines (config, pair, status)──▶ remote server (child process)
```

- **`cwd remote`** — a mode of the daemon binary (the app already ships `cwd`, so no
  second 60 MB binary). The cockpit spawns it and drives it over stdio; it dies with the
  app (killed on quit, and it exits when its stdin closes). `cw remote serve` runs the same server headless (projects from `--project`).
- **A curated API, not a passthrough.** The existing gateway shuttles daemon JSON-RPC
  behind an allowlist; the phone instead speaks a small API of its own, and the server
  calls the daemon itself, injecting `workspaceId` (the phone never names one):

  | Phone method | Does |
  |---|---|
  | `hello {token}` | must be the first frame, within 10 s |
  | `projects` | the projects open in the cockpit (root, name) |
  | `sessions {project}` | `session.list`, trimmed to what the page shows |
  | `launchers {project}` | the Mac's launchers (id, label, available) |
  | `watch {project, session}` / `unwatch` | `session.attach`; output forwarded while watched |
  | `send {project, session, data}` | `session.input`, ≤ 4 KB per call |
  | `create {project, name, launcher}` | `session.new` + `session.resume` with a launcher **id** (the daemon resolves it from Settings; a command line never comes from the phone) |
  | `start {project, session, launcher}` | `session.resume` for a stopped session, launcher by id only |
  | `note {project, session, text}` | `session.note` |

  Pushed: `output`, `exit` (watched session), `changed` (a project's sessions changed).
- **Which projects:** only those the cockpit has open, pushed over the control channel
  whenever that list changes. A phone naming any other root gets `PROJECT_NOT_OPEN`.
- **Pty size:** the daemon now reports each running session's size in `session.list`
  (`cols`, `rows`), so the phone draws the same grid the desktop pane sized and never
  resizes the pty (a phone-sized pty would reflow the desktop pane).

## Pairing and devices

- Settings → Remote → **Pair a phone** shows a QR code per reach
  (`https://<wifi-ip>:<port>/#pair=CODE`, `http://<tailscale-ip>:<port>/#pair=CODE`).
  The code: 10 characters from a 32-letter alphabet (50 bits), one at a time, valid for
  2 minutes, burned after 5 wrong tries or its first use. It is in a fragment, so it
  never reaches a server log or a Referer; the page strips it from the address bar.
- The phone posts `{code, name}` to `/api/pair` and receives a **device token**
  (32 random bytes). Only `sha256(token)` is stored, in
  `~/.crossweave/remote/devices.json` (dir 0700, file 0600, atomic write), with a
  name, created and last-seen times. The phone keeps the token in its localStorage.
- Settings lists the devices with **Remove**. The server re-reads the file when its
  stamp changes (checked every 2 s) and closes a removed device's sockets at once, so
  `cw remote revoke` works without the cockpit too.

## Transport

- **Tailscale:** plain HTTP bound to the 100.64.0.0/10 address of a tunnel interface
  (`utun*`, `tailscale*`) only — some networks hand out that range on the Wi-Fi itself. The tailnet
  already authenticates and encrypts every packet; only the user's devices can route to
  it.
- **Wi-Fi:** HTTPS bound to the chosen private address. The Mac makes a small local CA
  and a leaf certificate for that address (pure `node:crypto` + a DER writer — no
  openssl, no dependency), key files 0600 under `~/.crossweave/remote/`. The phone
  warns once (trust on first use), or the user installs the CA from the page to remove
  the warning. The leaf is re-issued when the address changes or it nears expiry.

## Threat model

| Threat | Mitigation |
|---|---|
| Someone else on the Wi-Fi reaches the port | nothing without a device token; pairing needs a code shown only on the Mac, 2 min, 5 tries; rate limits per address |
| Someone on the Wi-Fi tampers with the page (active attacker) | **Only partly.** HTTPS protects after the phone trusts the Mac's CA, but the first visit is trust-on-first-use: an attacker spoofing the network at pairing time can serve their own certificate, which the user taps through too, and redeem the code. The pairing dialog says so, recommends Tailscale, and shows the fingerprint to compare. Tailscale has no such window. |
| The local CA's key is read by another process | The CA is name-constrained to no real DNS name (`*.invalid`) and `pathLen 0`, so trusting it does not let that key impersonate websites. IP ranges are not constrained: BoringSSL refuses iPAddress constraints. |
| A phone is lost | Remove it in Settings: sockets close at once, token dead |
| Another web page in the phone's browser | Origin must equal the Host; Host must be one of the bound addresses (DNS rebinding); token in a frame, never a cookie (no CSRF) |
| XSS on the page stealing the token | no inline script (`script-src 'self'`), text only via `textContent`, output only through xterm |
| A paired phone doing damage beyond a session | no kill / delete / land / gc / file reads / command lines; audit log of every action (never its content). **But a device token is shell access:** typing into a session is running commands as the user. The missing methods prevent accidents, not a malicious token holder — the token is the boundary. |
| Oversized frames or floods | 64 KB frames (checked after Bun's ws has buffered the frame, so bounded by socket counts below), 4 KB input, 2 KB pair body with a 5 s deadline, header/request timeouts, at most 4 sockets per address and 16 in all before sign-in, 4 per paired phone, per-address failure limits |
| A daemon error reveals paths | only session/launcher errors reach the phone in words; everything else is a generic sentence |
| The server exposed by mistake | refuses `0.0.0.0`/`::`; off unless turned on; turning it off kills the process |

`/security-review` over the diff before merge.

## Not in this milestone

- Push notifications to a closed page (needs a push service outside the tailnet).
- `tailscale serve` HTTPS with a real certificate (possible later; plain HTTP over the
  tailnet is already encrypted).
- Viewing diffs or files from the phone.
