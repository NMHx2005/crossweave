# Diff comments — known limitations

Spec: `2026-10-10-diff-comments-design.md`. Plan: `docs/superpowers/plans/2026-10-10-diff-comments.md` (with the amendments from its
adversarial review).

## What shipped

Comment on a line of a diff, then paste every comment into the session's shell as one message — **never pressing Enter**. Surfaces:
the Changes pane (committed changes) and the Checkpoints dialog ("This turn" / "Since"). Cockpit only: no daemon, RPC, CLI, schema
(still v18) or dependency change.

- A gutter `+` on every added, deleted and context line; an inline editor (max 2000 characters); Edit / Delete; a sticky bar with the
  count, **Send to <session>'s shell** and **Clear**.
- A comment is anchored by path, side (`new` for added/context, `old` for deleted), line number and the line's text. After a diff
  reload it is matched back by all four; one that no longer matches is listed in the bar as **outdated**, still sendable.
- The message names `path:line`, quotes the line, and marks removed and outdated lines. It goes through `planSend(..., {enter: false})`:
  an agent in the shell receives one bracketed paste; a plain shell and a closed shell are refused and the comments are kept.
- `patchSections` now numbers every body line from its hunk header. It tells a deleted `-- x` (arrives as `--- x`) from a file header
  by the hunk's counts, treats `\ No newline at end of file` and `old/new mode` as metadata, and reads quoted (`core.quotePath`),
  space-containing and `diff.mnemonicPrefix` paths. A test checks, against real `git diff` output, that every numbered line points at
  the same text in the file it names.

Verified live on the real cockpit with `apps/cockpit/scripts/diff-comments-check.ts` (15 checks): the menu entry, gutter buttons only on
commentable lines, the editor takes focus, Escape closes the editor but not the dialog, Add, the bar's count, a plain shell refused with
its reason and the comment kept, the agent recognised, **the bytes that reached a raw-mode fake agent** are one bracketed paste naming
the file, line, quote and comment with no `\r` after it, and the bar gone once delivered.

## Limitations

- **Comments live in the window's memory only.** Closing the pane or dialog, or quitting, discards them; so does a **backdrop click**
  on the Checkpoints dialog (no confirmation), and choosing another diff there (the line numbers belonged to the previous one).
- **A plain shell cannot receive the message** (a multi-line paste would run each line). The person starts an agent there first; there is
  no "copy to clipboard" fallback.
- **Numbers and quotes go stale after more edits.** The numbers are those of the diff as shown. A comment on a very common line
  (`}`, a blank line, `return`) can re-match another line that has the same text and number after a reload instead of being listed as
  outdated. The quote is what lets the agent find the place.
- **The Changes pane shows committed changes only** (`session.diff`), and agents mostly leave work uncommitted: the Checkpoints dialog
  is where comments are most useful. The Changes pane path is covered by the shared component's tests and the build, but was not
  driven live.
- **One gutter button per diff line.** A diff cut at 512 KB is about 10–13 thousand rows, about three times the DOM it had before; the
  patch and the matching are memoised, but each poll still re-renders the rows. Not measured on a large diff. A reader who tabs
  through a diff meets a button per line (the bar is placed before the diff to stay reachable).
- **Truncated patches** keep exact numbers for the lines that are there; the cut part has nothing to comment on.
- **Control characters are dropped, not shown.** Anything `cleanPromptText` strips (ESC, NUL, DEL, C1) disappears from a quote or comment;
  a CR, line/paragraph separator and bidi control in a quoted line become visible marks (`␍`, `␤`, `⁇`) instead.
- **Prompt injection is not solved, only made visible.** Diff text is written by an agent or a repository and is quoted into the
  message; it is pasted without Enter, so the person reads it first, but an agent that later reads the message reads the quote too.
- **Restricted environments:** two cockpit tests that need a pty / unix socket (`fidelity attach path`, `DaemonBridge … socket`) fail
  inside a sandbox, as before; they pass outside it.

## Ideas not built

Persisting comments across restarts, replying or resolving, file-level comments, sending to a different session, a copy button for a
plain shell, and a confirmation on closing the dialog with unsent comments. Features 3 (auto-run the session check at turn end) and 4
(sensitive-file flags) of the series are separate milestones.
