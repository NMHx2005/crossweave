# Diff comments — review an agent's diff line by line and paste the notes into its shell

**Date:** 2026-10-10
**Status:** Draft for review (the design was approved in chat 2026-10-10; this written spec is new)
**Branch:** `feat/diff-comments` (second of four: checkpoints → **diff comments** → auto-check → sensitive-file flags; cut from `feat/checkpoints`
because the "This turn" diff it attaches to lives there)

## Why

After a turn, the person reads the agent's diff and has remarks ("rename this", "why was this guard removed?"). Today those
remarks are typed from memory into the shell, with the file and line copied by hand. The cockpit already shows the diff and
already knows how to put text into a session's shell safely (`planSend`). Missing: a way to anchor a remark to a line and send
all of them as one message.

Success looks like: click a line, type a note, repeat, press one button; the notes arrive in the session's shell as one
message naming `path:line` and quoting the line, and **nothing is executed until the person presses Enter**.

## Non-goals

- No persistence: comments live in the cockpit window's memory and are gone when the pane or dialog closes or the app quits.
- No threads, replies, resolved state, file-level comments, or comments on another session's shell. The destination is the
  session whose diff is shown.
- No daemon, RPC, CLI, database or schema change (`SCHEMA_VERSION` stays 18). No new dependency.
- Enter is **never** pressed for the person.

## Where it appears

A shared `CommentableDiff` (thin hooked shell over the hook-free `DiffLines` and `ReviewBar`) replaces the two hand-rolled diff renderers:

1. `ChangesPane` — the committed changes a land would merge (source label: `the committed changes`).
2. `CheckpointsDialog` — the "This turn" / "Since" diff (source label: `checkpoint #3 → #4` / `checkpoint #3 → now`).

The second matters more: agents mostly leave work uncommitted, which `ChangesPane` cannot show.

## Behaviour

- Every **added, deleted or context** line gets a small `+` button in a gutter (keyboard-focusable, `aria-label` names the line).
  Hunk headers, file headers, binary-file notes and `\ No newline at end of file` carry no button.
- The button opens a textarea (max 2000 characters) under the line; **Add** stores the comment, **Cancel**/Escape drops it.
  A stored comment shows under its line with **Edit** and **Delete**. Empty text cannot be added.
- A bar under the diff reads `N comments` with **Send to <session>'s shell** and **Clear**. It is hidden at zero.
- A comment is anchored by `{path, side, line, text}`: `side` is `new` for added/context lines (the line number in the new file) and
  `old` for deleted lines; `text` is the line's content without its `+`/`-`/space marker, cut at 200 characters.
- When the diff is reloaded (`ChangesPane` refetches whenever the session list changes) comments are matched back to lines by
  `{path, side, line, text}`. A comment with no matching line is listed above the bar as **outdated** with its anchor, stays
  sendable, and can be deleted. Nothing is silently dropped.
- In the dialog, choosing another diff (`This turn` / `Since` on another row) clears that dialog's comments, because the line
  numbers belong to the previous diff; the bar's **Clear** is the same action on demand. (State is local to the component;
  closing the dialog discards it.)

## The message

Built by a pure function from the comments, in file order then line order (`old`-side comments sort after the `new` ones of the
same file, by line; outdated ones are marked `(outdated)`):

```
Review comments on <source> (<N>):

1. <path>:<line>
   > <quoted line>
   <comment, continuation lines indented 3 spaces>
2. <path>:<line> (removed line)
   > <quoted line>
   <comment>
```

The quote is what lets the agent find the place after the file has moved on; the numbers are those of the diff as it was shown.

## Sending

`planSend(text, [target], {enter: false})` (existing, unchanged) decides, before anything is written:

- an agent in the session's shell → one bracketed paste, **no `\r`**; the toast says "Pasted N comments into <name>'s shell —
  press Enter there to send them";
- a plain shell → refused (a multi-line paste would run each line), the toast gives `planSend`'s reason;
- shell closed / text longer than `MAX_PROMPT_CHARS` → refused with that reason.

On success the comments are cleared; on refusal they are kept. Control characters in comments or quoted lines are stripped by
`cleanPromptText` (no ESC can end the paste early). The cockpit's input channel is the same one the prompt composer uses.

## Units

- `src/lib/review-comments.ts` (pure): `numberLines(section) → NumberedLine[]` (reads `@@ -a,b +c,d @@`, advances old/new counters,
  skips `\` lines), `anchorOf`, `matchComments(comments, numbered)`, `formatReview(source, comments) → string`.
- `src/lib/patch.ts`: `kindOf` classifies lines starting with `\` as `meta` (today they fall into `context`).
- `src/ui/CommentableDiff.tsx`: renders sections with gutters, the editor, outdated list and bar; props `{ patch, truncatedNote, source,
  target, send(id, data), onToast }`. Owns the comment state.
- `ChangesPane.tsx`, `CheckpointsDialog.tsx`: use it; `ProjectView.tsx` supplies `send` (plan → `api.sendInput` → toast).
- `app.css`: gutter, editor, comment, bar. Tokens only (the token test forbids literal colours).

## Errors and edge cases

| Case | Behaviour |
|---|---|
| Diff truncated at 512 KB | Line numbers stay exact (they come from hunk headers, not from position); the cut part simply has no lines to comment on. The existing "longer than shown" note stays. |
| File added / deleted whole | `new file`/`deleted file` metas carry no button; its lines are numbered from `@@ -0,0 +1,N @@` / `@@ -1,N +0,0 @@`. |
| Hunk header with omitted count (`@@ -3 +3 @@`) | Count defaults to 1. |
| Path with spaces or non-ASCII | Taken from the `b/` side of the `diff --git` header as today; shown and sent verbatim. |
| Comment text with newlines / control characters | Newlines kept and indented; controls stripped at send. |
| Same line commented twice | Allowed: two comments, listed in creation order. |
| Send fails (RPC error) | Error toast with the plain message; comments kept. |
| Shell busy (agent mid-turn) | Sent anyway: it is a paste into the prompt, the same as the composer. |
| Session without its own branch (`shared`) | `ChangesPane` already shows no diff there; nothing new. |

## Testing

- `review-comments` (pure, exhaustive): added/removed/context numbering across several hunks, new and deleted files, omitted counts,
  `\ No newline`, binary note, no hunk; `matchComments` (moved, edited, deleted line → outdated); `formatReview` (ordering, multi-line
  comment, removed-line marker, long quote cut, a quoted line containing control characters and backticks).
- `patch.test`: the `\` line is `meta`.
- Render tests (preact walk, hook-free views only): gutter only on commentable lines, comment shown under its line with Edit/Delete,
  the composer only under the anchored line, `ReviewBar` hidden at zero / count / outdated list. Send's contract is tested through
  `deliverReview` (one `send`, no `\r`, plain shell refused) and `afterDelivery` (cleared on ok, kept on failure or refusal).
- `planSend` behaviour for this use (agent → paste without `\r`; plain shell → refused) pinned in a test next to the formatter.
- A live CDP script `apps/cockpit/scripts/diff-comments-check.ts` on the running cockpit: open Checkpoints → This turn, comment a
  line, Send, and read the text that reached a scratch session's pty (no `\r` after the paste).

## Security

- The only effect is text pasted into a shell the person already controls, through the existing, tested clean-and-frame path.
  No new IPC channel and no new daemon method; no filesystem or network access.
- Diff content is attacker-influenced (an agent or a repository wrote it) and is quoted into the message. It goes through
  `cleanPromptText`, and the message is pasted without Enter, so a malicious line cannot execute; the person reads it first.
  It could, however, steer an agent that later reads the message — a prompt-injection surface that already exists whenever the
  person pastes anything from a diff.

## Known limits to record

Comments are not kept across closing the pane (a backdrop click on the dialog discards them without asking); a comment on a very common line (`}`, blank) can re-match another line with the same text and number after a reload; thousands of gutter buttons are rendered for a large diff; a plain shell (no agent) cannot receive a multi-line message; a stale line number
after further edits is mitigated by the quote only; the dialog clears comments when the compared checkpoints change.
