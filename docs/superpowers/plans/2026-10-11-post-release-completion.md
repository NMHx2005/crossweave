# Post-Release Completion Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and complete each linked plan in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the known CI, Cockpit landing and website launch-quality gaps from the v0.6.0 release, then leave the repository's progress records accurate.

**Architecture:** Three independently reviewable projects have their own designs and implementation plans. Execute them sequentially in priority order: stabilize CI, make live-session land explicit and safe, then finish website launch quality. Keep project status/doc cleanup as the final closeout task.

**Tech Stack:** Bun/TypeScript, Bun tests, Electron/Preact Cockpit, static Bun website, GitHub Actions/Pages.

**Specs:**
- `docs/superpowers/specs/2026-10-11-ci-checkpoint-stability-design.md`
- `docs/superpowers/specs/2026-10-11-cockpit-live-session-land-design.md`
- `docs/superpowers/specs/2026-10-11-website-post-launch-quality-design.md`

## Global Constraints

- Bun `>=1.3.13`; CI pins Bun 1.3.14.
- Zero native modules; do not add dependencies without an explicit architectural decision.
- `main` stays linear and receives no commit, push or tag without explicit approval.
- Execute in an isolated worktree created when implementation starts; use one logical change per Conventional Commit.
- Run only one heavy gate at a time; use `bun test --max-concurrency=1` for the root suite.
- Every completed milestone updates its dated known-limitations file and the limitations digest.
- Do not include Apple notarization in this roadmap; it is deferred until the owner is ready to revisit it.

---

### Task 1: Stabilize the red CI gate

**Plan:** `docs/superpowers/plans/2026-10-11-ci-checkpoint-stability.md`

- [x] Read the latest failing job logs and compare both 2026-10-08 failures.
- [x] Diagnose before editing; preserve the automatic-checkpoint integration contract.
- [x] Pass the focused test repeatedly, `bun run typecheck`, and `bun test --max-concurrency=1`.
- [x] Wait for a successful GitHub Actions run before marking CI debt complete (`38233229200`, both jobs pass).
- [x] Record any remaining runner limitation and update current progress.

**Exit condition:** the failure cause is recorded and CI's root test job passes on the fix.

### Task 2: Add an explicit live-session land flow

**Plan:** `docs/superpowers/plans/2026-10-11-cockpit-live-session-land.md`

- [x] Preflight uncommitted session work; never stop or remove its worktree while uncommitted files remain.
- [x] Ask clearly before stopping the live shell and landing committed work.
- [x] Keep blocked evidence, unknown-evidence confirmation, failed-check warnings and sensitive-file warnings intact.
- [x] Verify cancel, dirty work and successful live land in tests and a scratch Cockpit project; unit tests cover idle and unknown-evidence paths.
- [x] Update the product limitation only after the user-visible flow works.

**Exit condition:** a running session can only be stopped by this flow after explicit confirmation and only when the preflight finds no uncommitted files.

### Task 3: Finish the website launch-quality work

**Plan:** `docs/superpowers/plans/2026-10-11-website-post-launch-quality.md`

- [x] Make sitemap URLs, canonical URLs and the robots reference use HTTPS on the production domain; retain project-site base-path tests.
- [x] Make video controls work without JavaScript and prevent autoplay when reduced motion is requested.
- [ ] Have a Vietnamese-fluent reviewer proofread visible website copy and preserve EN/VI parity.
- [x] Perform and record the bounded browser/accessibility checks; report unavailable browsers as untested.
- [ ] Pass the website tests and verify the deployed artifact after Pages succeeds.
- [x] Defer search, RSS, theme switching, `llms.txt`, translated docs and feature pages until usage or feedback warrants them.

**Exit condition:** the deployed sitemap is correct, video behavior meets the progressive/reduced-motion contract, proofread status is clear, and browser results are recorded.

### Task 4: Refresh the repository's current-state records

**Files:**
- Modify: `docs/PROGRESS.md`
- Modify: `docs/HANDOFF-2026-10-11.md` or create a new dated handoff if work has moved to a later day.
- Modify: relevant dated known-limitations files and `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`.

- [x] Remove statements that 0.6.0 is unreleased or the website is undeployed.
- [x] Record local and remote CI results, live-session land behavior, sitemap/video fixes, proofreading status, and browser checks.
- [x] Keep notarization listed as deferred, not as a release blocker.
- [x] Review all remaining known limitations against the shipped code and leave unresolved items explicitly open.
- [x] Run `git diff --check` and review the final status before handoff.

**Exit condition:** `PROGRESS.md`, handoff and digest agree with `main`, the published release and the live site, and distinguish local branch verification from remote steps still waiting on integration.

### Follow-up outside this roadmap

The handoff also notes the GitHub repository Website field and README links that still use the old `github.io` address. The Website field is an owner-controlled GitHub setting; editing the README and committing that change to `main` needs the project's explicit approval. Keep these as a separate follow-up unless the owner authorizes them.

**Completion:** Execute Tasks 1–4 in order. Each sub-plan ends in its own commit; integrate only by approved fast-forward, then verify the final `main` CI and Pages runs. Do not mark unfinished browser checks or unavailable review as complete.
