# crossweave — Land & Lease Reliability (Design)

**Date:** 2026-09-15  
**Status:** Draft for review  
**Approach:** Land & Lease Reliability (Approach 1)  
**Horizon:** ~3 months solo daily-driver; multi-pane / thin desktop deferred

---

## 1. Goals and scope

### Positioning

crossweave remains the weft: parallel agents stay safe and mergeable. For this phase, a solo daily driver “wins” when `cw land` and runtime leases are trustworthy — not when the product looks like SpaceVibe Deck.

Deck-like attention UI and multi-pane cockpits are an intentional **later** phase (thin desktop client on the existing daemon). They are out of scope here.

### Success criteria

On one real repo with 2–4 sessions:

- `cw converge status` never presents sessions as landable without fresh evidence
- `cw land all` stops cleanly with a single clear error; no spurious squash no-op failures
- After each successful land, status reflects the new base before the next land
- `session rm` / `kill --rm-worktree` do not leave `.crossweave/cache|db` orphans
- Two sessions get distinct port blocks; config cannot override `PORT` via `ports.named`
- `cw session list` (and/or workspace info) shows enough lease detail to debug runtime collisions

### Non-goals (this phase)

- Cloning Deck (Agent Rail, desktop PTY panes, session restore product)
- M9 full VT emulation / thin Electron app
- Adversarial Safe Mode or intercepting Bash / non-Edit writes
- Cloud, team sync, analytics
- Full schema-first RPC retrofit (touch methods only when land/lease needs them)
- Auto `docker compose` lifecycle or Postgres schema create/teardown

### Phase 2 gate (explicitly later)

Open thin-desktop / multi-pane work only after the acceptance checklist in §5 is green **and** land+lease have been used as a habit on real sessions. Phase 2 is a thin client over the same daemon — not a second control plane.

---

## 2. Convergence / land reliability

### Problem

Today `conflictFree` roughly means “no known conflict edge,” not “proven safe.” An empty, stale, or degraded pairwise graph can make every session look landable. `cw land all` snapshots that list once and does not re-query after the base moves. Squash no-op branches can spuriously `LAND_MERGE_FAILED` and abort a batch. `tested: unverified` is easy to misread as “clean.”

### 2.1 Evidence gate

`converge.status` (and every `land all` path that consumes it) classifies each candidate:

| State | Meaning | Default `land all` |
|---|---|---|
| `ready` | Pairwise evidence is present and not stale relative to current base HEAD. If the workspace has a **trusted** `converge.testCommand`, a full-integration trial against current base HEAD must also be present and `clean`; if there is no `testCommand` (or it is untrusted), pairwise freshness alone is enough and land may still report `tested: unverified` | Eligible in `recommendOrder` |
| `unknown` | Missing trials, stale base SHA, or scheduler degraded mode | Do **not** auto-land; print why; `--force` may proceed with an explicit warning |
| `blocked` | Conflict edge or failed/dirty trial | Skip / stop per existing land policy; name the other session(s) |

“Fresh” means the stored trial’s base SHA matches the workspace base branch HEAD at status/land time. Scheduler quirks that record trials against a pre-lock HEAD must not surface as `ready`.

### 2.2 `cw land all` lifecycle

1. Fetch status with evidence classification  
2. Land only sessions in `ready` (unless `--force` with warning)  
3. After each **successful** land, re-fetch status before choosing the next session  
4. On first failure: stop with **one** error line (no double-print from CLI loop + `fail()`)  
5. Always surface `tested: unverified` vs `clean` in land/converge output so “landed” is not confused with “tested”

### 2.3 Spurious failure and message fixes

- After `git merge --squash`, if `git diff --cached --quiet`, treat as successful no-op (skip empty commit); do not raise `LAND_MERGE_FAILED`  
- On rebase conflict, combine stdout and stderr so conflicted paths are visible  
- `cw converge status` notes degraded mode and “no pairwise yet” explicitly  

### 2.4 Unchanged

- `cw config trust` / hash gate for `converge.testCommand`  
- Integration worktree lock (`withIntegrationWorktreeLock`)  
- Existing `--force` behavior (stop running session, then land), with clearer `unknown` warnings only  

---

## 3. Isolation / lease reliability

### Problem

Leases are cooperative env injection. This phase does not pretend to sandbox agents. It makes leases **honest, non-leaking, and visible** so a daily driver is less likely to believe isolation exists when it does not.

### 3.1 Port honesty

- Add `PORT` to the reserved env denylist so `ports.named` cannot override `PORT` or `CW_PORT_BASE`  
- Before allocating a block, probe **every port in the block** (base .. base+blockSize-1); if any is occupied, try the next block. Do not only probe the base port.

### 3.2 Disposal without leaks

`session rm` and `kill --rm-worktree` must delete leased `cache` and `db` paths **before** deleting session/lease rows — same semantics `cw gc` already applies for ended sessions.

### 3.3 Disk budget includes lease bytes

`assertDiskAvailable` / worktree measurement include `.crossweave/cache/<id>` and file-copy db files. Postgres `schema` strategy contributes **0** local bytes but remains visible in lease status.

### 3.4 Visibility

`cw session list` and/or workspace info shows a short lease summary: effective `PORT` / `CW_PORT_BASE`, `COMPOSE_PROJECT_NAME`, cache path, db strategy. No new multi-pane UI.

### 3.5 Explicit non-work

| Do | Do not |
|---|---|
| Keep docker/cache/db as record + env inject | Auto create/teardown Compose stacks or Postgres schemas |
| Fail clearly on acquire errors; best-effort rollback of partial acquires | Block agents that hardcode ports or ignore env |
| Document cooperative limits in known-limitations | Change default `db` strategy away from `none` without a separate decision |

---

## 4. Architecture notes

No new process topology. Changes stay inside:

- `src/convergence/` (`land.ts`, `graph.ts` / status shaping as needed)  
- `src/daemon/methods.ts`, `convergence-scheduler.ts` (evidence / freshness)  
- `src/cli/commands/{land,converge,session}.ts` (UX, single error line, lease summary)  
- `src/isolation/` + `src/domain/{session,gc}.ts` + `src/core/config.ts` (ports, disposal, disk)  
- `docs/superpowers/specs/*known-limitations*` digest updates  

CLI and existing TUI remain thin clients. Daemon remains sole state owner (founding decision D1).

---

## 5. Verification and acceptance

### Tests

- Pure unit: evidence classification (`ready` / `unknown` / `blocked`), squash no-op detection, `PORT` denylist, disk measure including cache/db  
- Integration: `land all` re-fetches after one land when base moves; session dispose removes cache dir; named `PORT` rejected at config load  
- No desktop / multi-pane E2E in this phase  

### Manual checklist (solo, real repo, 2–4 sessions)

1. Status never marks all sessions landable with no fresh pairwise evidence  
2. `cw land all --yes` stops cleanly; one error; no squash no-op false failure  
3. After a land, matrix/status reflects the new base before the next land  
4. `session rm` / `kill --rm-worktree` leave no orphan cache/db under `.crossweave/`  
5. Two sessions get different port blocks; `ports.named.PORT` is rejected  
6. Session list shows enough lease detail to debug a suspected runtime clash  

### Suggested implementation order

1. Land strategy fixes (squash no-op, rebase messages)  
2. Evidence gate + `land all` re-fetch + single error line + unverified/clean clarity  
3. Lease disposal + disk accounting + `PORT` denylist + full-block probe  
4. Lease visibility on list/status  
5. Refresh known-limitations digest (remove stale claims; state cooperative lease limits clearly)  

### Accepted risks

- Agents that ignore lease env can still collide at runtime — mitigated by visibility and docs, not overclaim  
- Stricter evidence gates mean `land all` does less until trials catch up — intentional  
- Full-integration + trusted tests add latency; freshness/staleness defaults must be tunable via existing converge config knobs where possible  

---

## 6. Relationship to prior work

Builds on shipped M1 (leases), M4 (convergence/land), and later trust-hash for `testCommand`. Closes selected gaps from:

- `2026-08-10-m1-known-limitations.md` (cache/db dispose paths, `PORT` override, disk budget blindness)  
- `2026-08-12-m4-known-limitations.md` (squash no-op, land-all UX/staleness edges)  

Does **not** expand Safe Mode enforcement (M5) or ship M9 interactive panes.

---

## 7. Open decisions locked by this brainstorm

| Decision | Choice |
|---|---|
| Product shape | Hybrid: daemon + CLI/TUI now; thin desktop later |
| 3-month win | Solo daily driver |
| Primary pains | Land/merge order, then runtime isolation |
| Deck-like surface | Deferred; destination multi-pane via thin desktop after this phase |
| This milestone approach | Land & Lease Reliability only |
