# Hardening round 2 — design and plan

**Branch:** `feat/hardening-round2` (from `main` @ `fbb8ef0`). **Tier:** large (many layers); three milestones, each ends
with the local gate and its own commits. Out of scope on purpose: the iOS app, notarization/auto-update's "Restart to
update", a Linux cockpit, testing `cw check` against the merge result, sending the composer to non-session terminals.

## Decisions (owner, 2026-10-08)

- Land gate is **opt-in**: `converge.requireCheck` (default off). On, the daemon refuses `land` / `land all` unless the
  session's check verdict is a fresh `pass`; `force` bypasses it. The cockpit turns its warning into a block.
- Update notice is **on by default** with a Settings switch; offline / 403 / garbage answers are silent; "Later" hides that
  version; "Download" opens the release page. The main process does the one outbound request.
- Composer: **cancel for Refine** only. No new send targets.
- `cw check` gets the session's lease env. Session history keeps the **500 newest** rows (trimmed on insert) and gains
  a status/name filter.

## Milestone 1 — small, visible gaps

1. Rail chip for `setup: 'failed'` (`rail.ts` `setupChip`, `Sidebar.tsx`, CSS, test). Clicking offers the existing re-run.
2. Session history: `status` / `q` filter in `session.history`, `cw session history --status/--query`, dialog filter box;
   retention trim in the repository.
3. Status inference starts from the real pty size instead of 80×24.
4. `cw debug`: more error shapes (Rust, Go, Node, npm 7+, pytest, Java) and more token shapes in the scrubber
   (`github_pat_`, Slack, Stripe, Google, JWT, npm, GitLab, SendGrid, `Authorization: Basic`); each with a test and a
   negative case so ordinary prose is not scrubbed.
5. End-to-end test for `cw daemon stop` (start, stop, socket gone, second stop says none running).

## Milestone 2 — landing evidence

6. `converge.requireCheck` end to end (config, validation, daemon refusal `CHECK_REQUIRED`, cockpit block, tests).
7. Lease env for `cw check` (idempotent acquire; a stopped session gets none, documented).
8. Compare shows pairwise conflict / clean / unknown from `converge.status`.

## Milestone 3 — cockpit

9. Refine can be cancelled (abort through the injected runner, new channel, button).
10. Update notice (main process check, IPC, corner notice, Settings switch, settings-guard entry).
11. Split the renderer bundle (`manualChunks` plus lazy dialogs) to clear the >500 kB warning, or record why not.
12. Dashboard: expose the delete/idle thresholds only if cheap; otherwise record them as known limits.

Every milestone: tests first for new behaviour, `bun run typecheck`, `bun test --max-concurrency=1`, `bun run build`
(and the cockpit's build/tests when `apps/cockpit` is touched), then update `docs/PROGRESS.md`, a
`2026-10-08-hardening-round-2-known-limitations.md` and one digest line.
