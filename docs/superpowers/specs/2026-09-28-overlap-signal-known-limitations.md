# Overlap signal — Known Limitations

**Date:** 2026-09-28
**Design:** `2026-09-28-mergeability-hardening-design.md` (Part A) · **Plan:**
`../plans/2026-09-28-mergeability-hardening.md`

## What is built

- `session.list` rows carry `overlaps: { session, paths }[]` for worktree sessions.
- `cw overlap [--json]`, and an `overlaps:` section in `cw converge status`, both from the
  on-demand `overlap.list` RPC (fresh, one call).
- The cockpit rail shows a `⇄ name` badge, with the shared paths in its tooltip.
- One shared `RepoScanner` pass feeds both the git badge (`GitCounter`) and the overlap
  signal (`OverlapTracker`), so the signal costs no extra `git status`.

## Gaps

- **File-level only.** No line or symbol granularity: two sessions editing different parts
  of the same file still read as an overlap.
- **A path in `git status` may be incidental.** A formatter, a build artifact, a `touch` —
  the signal is a guess of intent, never a claim about what a session means to change.
- **The committed half shrinks as the base advances.** `committedPaths` is
  `git diff <base>...HEAD`; once a file a session touched lands in the base, the merge-base
  moves forward and the path drops out. The uncommitted half is unaffected. This is
  inherent to a diff-against-base signal, not a bug.
- **No rename pairing.** `--no-renames` makes a rename read as delete + add (two paths), so
  a session renaming `x.ts` while another edits `x.ts` over-reports the overlap.
- **The rail's overlaps lag one redraw.** They are filled by the background tracker on
  `session.list`; the next redraw shows them. The CLI's `overlap.list` answers fresh, so the
  one-shot command never shows a stale answer.
- **The shared checkout and plain folders take no part.** A session in the project folder has
  no branch of its own and a plain folder has no git, so neither is compared — a shared
  session colliding with a worktree session is not reported.
- **A signal, not a guard.** Nothing here can prevent a write; the only hard verdict remains
  the trial merge.
