# Remote / phone access — plan

Spec: `docs/superpowers/specs/2026-09-27-remote-phone-design.md`. Branch:
`feat/cockpit-roadmap` (Phase D of `2026-09-27-cockpit-roadmap.md`). TDD per task;
one commit per task or tightly-related pair.

## Tasks

1. **Settings** — `remote: { enabled, tailscale, wifi, wifiAddress?, port }` in
   `src/core/settings.ts` (`cleanRemote`, load/save/validate). Tests: defaults, bad
   port, bad address, unknown keys dropped.
2. **Addresses** — `src/remote/addresses.ts`: from `os.networkInterfaces()`, the
   Tailscale IPv4 (100.64/10) and the Wi-Fi candidates (RFC 1918, not bridge / vmenet /
   docker / utun), `en0` first. Refuses wildcard binds. Pure; tests over fixtures.
3. **Devices** — `src/remote/devices.ts`: `devices.json` (0700 dir, 0600 file, atomic),
   `addDevice` → token once, `verifyDevice` (sha256 + timingSafeEqual), `removeDevice`,
   `touchDevice` (throttled last-seen), `devicesStamp`. Tests in a temp home.
4. **Pairing** — `src/remote/pairing.ts`: one live code, 50 bits, 2 min, 5 tries,
   single use; injected clock and randomness. Tests: expiry, burn after tries, reuse,
   replacement, case/space tolerance.
5. **Certificates** — `src/remote/cert.ts`: DER writer; local CA + leaf for the Wi-Fi
   address (SAN, serverAuth, ≤ 397 days); reuse vs re-issue; files 0600. Tests parse
   with `X509Certificate`, verify the chain, and complete a real TLS handshake.
6. **QR** — `qrcode-generator` (MIT, zero deps, pure JS); `src/remote/qr.ts` → module
   matrix + terminal rendering. Tests: size/finder patterns, round-trip not required.
7. **Daemon pty size** — the runtime keeps each session's cols/rows; `session.list`
   reports them. Test through the runtime with the fake adapter.
8. **Hub** — `src/remote/hub.ts`: open projects, one DaemonClient per project (lazy,
   dropped on close), the phone API with injected `workspaceId`, watch fan-out, change
   pushes, input cap, launcher-id-only create, audit log. Tests with a fake daemon.
9. **Server** — `src/remote/server.ts`: HTTP (Tailscale) / HTTPS (Wi-Fi) listeners,
   Host and Origin checks, security headers, `/api/pair`, WebSocket auth (first frame,
   10 s), per-address failure limits, 64 KB frames, revocation sweep. Tests over
   127.0.0.1 with real sockets (outside the sandbox).
10. **Phone page** — `src/remote/web/`: projects → sessions → a live session with an
    answer bar and quick keys; pairing screen; no inline script. Pure helpers tested.
11. **Entry points** — `cwd remote` driven over stdio (cockpit), `cw remote serve [--pair] |
    devices | revoke`; the stdio control protocol (config, pair, status, paired).
12. **Cockpit** — `electron/remote-host.ts` (spawn, restart on settings/projects
    change, stop on quit), channels, Settings → Remote (reach, port, status, devices,
    Remove), Pair dialog (QR per reach, countdown), a sidebar chip while a phone is
    connected. Tests for the host protocol and the pure UI helpers; CDP check.
13. **Close-out** — known-limitations + digest line, `/security-review`, gates, install.

## Gates

`bun run typecheck` · `bun test --max-concurrency=1` · `bun run build`; cockpit
`bun test` · `bun run build`; CDP screenshot of Settings → Remote and the pair dialog;
the phone page driven in a mobile-sized browser against a real server.
