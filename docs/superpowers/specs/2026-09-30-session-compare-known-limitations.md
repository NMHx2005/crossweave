# Compare two sessions — known limitations

Spec: `2026-09-30-agent-workflow-features-design.md` §3. Plan: phase 3.

## What shipped

Row menu → **Compare with another…** opens a modal with two sessions side by side (this one on the left, opposite it the
session it overlaps most with, else the first other one; either side can be changed). Each column shows the session's landing verdict, its
tests chip, its files with `+/−` counts, an expandable patch per file, and its own **Land this one** button. Files
both touched are marked `both` (and `both · same` when the two made exactly the same change there). Pure model in
`src/lib/compare.ts`; measured on the real app with `apps/cockpit/scripts/compare-check.ts` (8 checks).

## Limitations

- **A modal, not a pane.** It is not part of the layout, is not saved in layouts, and is not reachable from `cw pane`.
- Only sessions with a branch of their own can be compared (a session in the project folder has nothing to land).
- "Same change" compares the added and removed lines of each file's patch text. A patch cut at the 512 KB limit never
  counts as the same, and two changes that differ only in whitespace are different.
- "Both" says two sessions touched a file, not that they conflict: the verdict per side is still the convergence
  engine's, and landing one changes the other's verdict.
- The diff is `session.diff` (committed work); uncommitted files are counted per side and never shown.
- Landing from the modal closes it and hands over to the normal land flow (confirmations included).
- A session created while the rail was refreshing can be missing from the list until the next refresh.
