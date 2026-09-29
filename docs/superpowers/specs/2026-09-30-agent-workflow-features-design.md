# Agent workflow features — `cw notify`, session checks, compare, prompt composer

**Date:** 2026-09-30
**Status:** Approved in chat 2026-09-30 (items 1, 3, 4, 5, 6 of the proposal list)
**Branches:** `feat/cw-notify` → `feat/session-checks` → `feat/session-compare` → `feat/prompt-composer`, each stacked on
the previous and all on `fix/status-glyphs` (the status-mark fix they build on).

## Why

The rail's status is a guess made from what an agent's terminal shows (`src/daemon/session-status.ts`); it is reliable for
Claude Code, Codex and Gemini and approximate for the rest. The person runs several agents in parallel and needs to
know (1) when one is really done, (2) whether its work is fit to land, (3) which of two attempts is better, and (4)
to hand the same task to several agents without retyping. Four features, small and independent enough to ship one by one.

## 1. `cw notify` — an explicit signal

`cw notify "<message>" [--kind done|ask] [--session <name|id>]`, default kind `done`, default session `$CW_SESSION_ID` (every
session shell has it). An agent's hook or a script calls it: the signal is exact where the screen is a guess.

- RPC `session.notify {workspaceId, idOrName, kind, message}`. Kinds are a closed set. The message is one line of at most
  200 characters, control characters stripped, and is only ever displayed (notification body, row tooltip) — never run.
- Effect in the daemon: the activity tracker marks the session `asked` (`ask`, with `rang`, so it is amber) or *finished*
  (`done`, `asked` without `rang`, whatever the agent detection says), remembers `signal {kind, message, at}`, and
  broadcasts `tui.invalidate`. The next keystroke in the session clears both, like every other "waiting for you" state.
- The rail shows the existing marks: ✓ for `done`, amber for `ask`; the window's desktop notification (when the app is
  away) carries the message.
- **Security:** the caller is unauthenticated by design (same-user unix socket, like the command bridge). The worst a
  hostile local process can do is put a marker and a sentence on a row. No request runs anything.

## 2. Session checks — is this fit to land?

`cw check [session]` and a rail action "Run checks" run the project's **already trusted** `converge.testCommand` in the
session's worktree and show the verdict on the row (spinner → `✓ tests` / `✗ tests`).

- Reuses the trust gate of `land` (`cw config trust`): an untrusted or missing command is `CHECK_UNTRUSTED` /
  `CHECK_NOT_CONFIGURED`, never run. One run per session at a time; timeout; output tail capped (the same runner as
  `land`'s pre-land test, extracted, not copied).
- A result is remembered in memory with the worktree's state it ran against (HEAD + change count); when the worktree
  moves on, the verdict shows as stale (dim) rather than as a lie.
- The daemon never runs a command the person did not trust.

## 3. Compare two sessions

Rail context menu → "Compare with…" opens a **modal view** with the two sessions' changes side by side (the existing
session diff, twice), the files both touched marked, each side's checks verdict, and a `Land this one` button per side.
A modal, not a new pane kind: a pane would reach into the layout core, saved layouts and `cw pane` for a view that
lives a minute. (Limitation recorded.)

## 4. Prompt composer — write once, refine, send to several

A dialog (⌘⇧P, "Prompt" in the command bar): a text area for the prompt, an optional **Refine** button, a list of
sessions to send to (default: the focused one), **Send**.

- **Refine is off until a command is set** in Settings → Prompt (a program the person names; the app does not choose an
  AI). It receives the draft on stdin, prints the refined prompt; argv, no shell, timeout, output cap, run by the main
  process from the *saved* settings (never from the request). The proposal is shown beside the draft; the person accepts
  or discards it. Never automatic.
- **Send** writes the text to each chosen session's terminal and never presses Enter unless "Press Enter after" is ticked.
  A session with a recognised agent gets a bracketed paste (one paste, multi-line safe); a plain shell gets single-line
  text only — a multi-line prompt to a plain shell is refused for that session, named in the dialog, because a raw newline
  would run each line.
- The dialog shows exactly what goes to which session; nothing is sent by the act of refining.
- The refine command is the same idea as the removed voice feature's (tag `v0.5-voice-input`), now on text.

## Non-goals

Voice, an AI picker or launcher, a hosted service, auto-landing on green checks, a durable history of notifications.

## Testing

Pure logic in root `bun test` (tracker signals, check runner with a fake spawner, refine runner, paste framing, compare
overlap); cockpit `bun test` for the view models; the real app measured with scripts on a scratch HOME as in earlier
phases. Each phase ends with a known-limitations file and a digest line.
