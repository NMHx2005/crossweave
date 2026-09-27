# Remote / phone access — known limitations

**Date:** 2026-09-27 · Design: `2026-09-27-remote-phone-design.md` · Plan:
`../plans/2026-09-27-remote-phone.md`

What shipped: Settings → Remote in the cockpit (Tailscale and/or the same Wi-Fi, a
port, paired phones with Remove), pairing by QR code or a 10-letter code, and a phone
page to see every open project's sessions, watch one live, answer it (text + quick
keys), start a new or stopped session with one of the Mac's launchers, all through
`cwd remote`; `cw remote serve | devices | revoke` for a Mac without the cockpit.

## Not verified on a real phone

- **iOS Safari and a self-made certificate.** Verified: the chain passes `openssl
  verify -x509_strict -purpose sslserver`, a TLS client that trusts only the local CA,
  and the page + socket in Chrome at iPhone size (over HTTP on loopback). Not verified:
  that iOS lets the WebSocket through after the user taps past the certificate warning
  once. If the page loads but stays disconnected, install the Mac's CA from the pairing
  page (`/ca.cer`) and enable it under Settings → General → About → Certificate Trust
  Settings.
- **Tailscale** is not installed on the development Mac: its path is covered by the
  address planning tests and the plain-HTTP listener tests on loopback only.

## By design, for now

- **No notifications to a closed page.** A push needs a push service outside the
  tailnet. iOS suspends a page in the background and drops its socket; it reconnects
  when shown again.
- **Plain HTTP inside the tailnet.** WireGuard encrypts and authenticates every packet,
  but the page is not a browser "secure context" there (no service worker, no web
  notifications). `tailscale serve` with a real certificate is a possible follow-up.
- **The phone draws the session's own grid** (the size the desktop pane set, 80×24
  for a session never shown on the desktop) with a font fitted between 5 and 14 px, and
  scrolls sideways when that is not enough. It never resizes the pty: that would reflow
  the desktop pane.
- **Output while a session is not being watched is not kept for the phone**; opening
  it again replays the daemon's last 64 KB of scrollback.
- **Only projects open in the cockpit**, and only while their daemon runs (the cockpit
  keeps it running). Their names are folder names, not the rail's display labels (those
  live in the window's storage).
- **The Wi-Fi address is pinned.** On another network the status says the address is
  gone and nothing listens until one is chosen again — never silently on the new one.
- **What a paired phone can do is fixed:** watch, type, start sessions with a launcher
  id, set a note. There is no per-device "watch only" level (the user chose full control,
  like Claude's Remote Control); kill, delete, land, gc, files and settings are never
  offered remotely.
- **The device token lives in the phone browser's storage.** Anyone holding the
  unlocked phone has access until the phone is removed in Settings (or `cw remote
  revoke`). Removal takes effect within 2 s (the devices file is polled).
- **Limits are per network address:** 10 failures in 5 minutes block the address for
  5 minutes. Behind a Wi-Fi NAT every device shares one address; through Tailscale each
  has its own.
- **The audit log** (`~/.crossweave/remote/audit.log`: pairings, connects, watches,
  typing without content, creates) keeps one rotated file past 1 MB and is not shown in
  the UI.
- **The older `cw gateway`** (per-project tokens, a desktop-sized page) remains as it
  was; the two are not unified.

## From the security review (2026-09-27)

Fixed: sockets before sign-in capped per address (4) and in all (16), 4 per paired
phone (the oldest closes); request, header and body deadlines; Tailscale detected only
on tunnel interfaces; the CA name-constrained (no real DNS name) with `pathLen 0`;
daemon errors other than session/launcher ones reach the phone as a generic sentence;
last-seen times in their own file so a removal is never written back; re-watching a
session no longer stacks close handlers in the daemon.

Accepted, and said here:

- **Wi-Fi pairing is trust-on-first-use.** An active attacker on the same network at
  the moment of pairing (ARP spoofing) can present their own certificate — which the
  user taps through just like the Mac's — relay the code and keep the device token.
  `/ca.cer` arrives over the same channel. The pairing dialog warns, recommends
  Tailscale and shows the fingerprint to compare; only Tailscale closes the window.
- **A device token is shell access.** Typing into a session runs commands as the user;
  the methods left out (kill, delete, land) prevent accidents, not a malicious holder.
- **Bun's ws buffers a whole frame** (up to ~16 MB) before the 64 KB check can refuse
  it; the socket caps bound how much strangers can make the Mac hold (≈ 256 MB worst
  case, briefly).
- **Anyone on the network can burn a live pairing code** with five wrong guesses (a
  nuisance, not access): show a new one.
- **The CA does not constrain IP addresses** (BoringSSL refuses such chains), so a stolen
  `ca.key` could still impersonate an HTTPS site reached by bare IP address.
- **A paired phone can start any number of sessions** (each a worktree); the disk guard
  still applies.

## Found while building

- Bun's WebSocket reports a server's close code 1001 to the client as 1000, so "remote
  access was turned off" uses the application code 4000.
- Under Bun, `server.close()` never calls back while upgraded sockets are counted unless
  `closeAllConnections()` is called first.
- A daemon from before this build drops the `remote` settings key on save: restart the
  daemons after installing (the install already does).
