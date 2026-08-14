# crossweave M6b — known limitations

Accepted gaps carried out of M6b (push notifications), found and deliberately
deferred during implementation — see
`docs/superpowers/specs/2026-08-14-m6b-push-notification-design.md` for the full
design this summarizes.

## macOS only

No degrade-with-a-warning on Linux/Windows — `platformSend()` returns a silent no-op
on any platform other than `darwin`. The feature is simply absent there, not
implied to work everywhere.

## Click-through requires `terminal-notifier`, an optional external dependency

Without it installed (e.g. via Homebrew), notifications fall back to `osascript
display notification` — informational banners only, no click action at all.
`display notification` has no action mechanism in modern macOS regardless of whether
crossweave ships its own app bundle, which it deliberately does not (design doc §1
non-goals — building and code-signing one would violate this project's "zero native
dependencies" principle).

## Click-through always opens Terminal.app, never the user's actual preferred terminal

If a user's daily terminal is iTerm2, kitty, Ghostty, or anything else, clicking a
notification still opens (or activates) Apple's built-in Terminal.app. Not solved by
this milestone — flagged directly during brainstorming as a real, known gap.

## T1 (ACP) "blocked" notifications show the session id, not its friendly name

`AcpAdapterDeps` (`src/adapters/acp.ts`) deliberately carries minimal dependencies —
`resolveWorkspaceId`, `decideBlocked`, `recordUsage`, and now `notify` — none of which
resolve a session's display name. The T2 (Claude Code hook) `blocked` path, by
contrast, has `sessions.resolve(...).name` cheaply available in `radar.check`'s own
handler and uses it. Widening `AcpAdapterDeps` further just for a notification title's
cosmetic polish was judged not worth the interface churn (every existing
`AcpAdapterDeps` test literal across three files would need another field). A T1
blocked notification's session identifier is therefore the raw session id, not its
human-chosen name.

## Background collision notifications show the session id, not its friendly name

The background collision path (`src/radar/retro-notify.ts`'s `notifyCollisions`)
reports both sides of a collision by raw session id. The live-hook collision path
(`radar.check`'s RPC handler) resolves both sides to their display name via
`sessions.resolve(...).name`. This is the same category of gap as the T1/ACP
blocked-notification limitation above, on the opposite path — not fixed in M6b for
the same reason (interface-widening cost judged not worth it for a notification
title's cosmetic polish).

## `land`/`convergence` throttle coalesces per session (or per pair), not per distinct outcome

A session that lands successfully, is re-landed, and fails within the same
6-per-10-minute gate window only gets the first notification, not a correction — the
gate key is `(session, '__land__', null)`, not something that also encodes the
outcome. Acceptable for an at-a-glance signal; the real record of what actually
happened is the event ledger (`cw blame`), unaffected by this milestone. Same
reasoning applies to `convergence`, keyed by the sorted session pair only.

## No GUI session (headless/SSH) means notifications silently never arrive

`osascript`/`terminal-notifier` failing to reach Notification Center at all (no
logged-in local GUI session) is caught inside `notify()`, logged once per daemon
process lifetime, and never surfaced anywhere else. A user running crossweave's
daemon over SSH with no local GUI session gets no signal that notifications are
configured but structurally unable to arrive.

## `notify_config` is per-workspace, matching `config_trust` — not per-daemon or global

Multiple workspaces served by the same daemon each have their own independent notify
preference, exactly like `converge.testCommand` trust already works. Not a limitation
so much as a design choice worth stating plainly: `cw config notify off` in one
workspace does not silence another workspace's notifications.
