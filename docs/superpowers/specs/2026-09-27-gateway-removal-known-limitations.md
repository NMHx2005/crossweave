# Gateway and browser remote access removed — known limitations

**Date:** 2026-09-27 · Last version with them: tag `v0.4-remote-web`

Removed: `cw gateway` (serve / token / revoke), its WebSocket server and web page, the
read/control token files, E2E sealing of session and terminal output with the gateway
key (daemon side) and its decryption (`DaemonClient`), the relay design, the telemetry
stub that lived beside it, and the root package's xterm dependencies it alone used.
The phone web page built on top of it (Phase D) was never merged.

- **Nothing listens beyond the daemon's unix socket** until the native iOS app brings
  remote control back (designed from scratch; the removed code is reference only).
- **Leftover files are not read any more.** A project that once ran `cw gateway token`
  still has `.crossweave/gateway.token`, `gateway.read.token` and maybe
  `gateway.audit.log`; they grant nothing now and can be deleted by hand.
- **Output is never sealed now.** A daemon from before this build, in a project with a
  gateway token, sealed output that a client from this build cannot open (it shows
  nothing for those chunks): restart the daemon after installing — the install does.
