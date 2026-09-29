# Prompt composer — known limitations

Spec: `2026-09-30-agent-workflow-features-design.md` §4. Plan: phase 4.

## What shipped

A dialog (⌘⇧P, or the pen button in the tab strip): a prompt text area, an optional **Refine**, a checklist of sessions
and a **Send** that writes the text into each chosen session's terminal. The preview lists per session exactly what
goes (`one paste into its agent` / `one line typed into its shell`) and what is refused and why. Enter is pressed only if
"Press Enter after sending" is ticked; the draft survives closing the dialog until it is sent. Refine runs the program named in
**Settings → Prompt** (argv, no shell, 60 s, 1 MB output, from the *saved* settings, never from the request) with the
instruction and the draft on stdin; its output is only ever a proposal — "Use this" or "Keep mine". With no command set the
dialog offers "Set up Refine…" instead. Measured on the real app with `apps/cockpit/scripts/prompt-check.ts` (15 checks,
with a fake agent that logs the exact bytes it receives and a fake refine command).

## Security notes

- **A prompt is text, never keystrokes.** `cleanPromptText` strips every control character but tab and newline (ESC, NUL,
  BEL, C1) before framing, so a text cannot end the bracketed paste early and have the rest run as typed input.
- **A plain shell is never sent more than one line**, because a raw newline would run each line; a multi-line prompt is
  refused for it and the dialog says so.
- **Nothing is sent by refining**, and the refine command sees only the draft, the instruction and — only if the person
  switched it on — the session's name, branch and changed-file count.
- The refine command is the person's own program: whatever it does with the draft (a hosted model, for example) is theirs to
  judge. The app does not choose or ship one. This is the same idea as the removed voice feature's refine step (tag
  `v0.5-voice-input`), now on text.

## Limitations

- **"Has an agent" is a guess** from the process tree (`detectAgents`); a session running an agent the app does not
  recognise is treated as a plain shell (single line only). A recognised agent is assumed to accept bracketed paste; one that
  does not would show the escape characters.
- **Sessions only.** Extra terminals (split panes) and non-session panes are not targets.
- Refine sends the *first ticked* session's context, not one per session, and only when the setting is on.
- The draft is kept in memory in the window: a reload loses it. There are no saved snippets or history.
- ⌘Enter sends; a bare Enter is a newline. There is no "undo send".
- One refine at a time; there is no cancel for a running refine command (it ends by itself within 60 s).
- Delivery is a write to the session's pty: a session that is busy (an agent mid-turn) queues it in its terminal input,
  which is the terminal's business, not the app's.
