# crossweave — Design Spec (V1)

**Date:** 2026-08-09
**Status:** Approved for planning
**License:** MIT

---

## 1. Positioning

Your agents run as parallel warp threads. **crossweave is the weft** — the cross-thread that binds them so the fabric holds together.

crossweave is a local-first tool that makes running many AI coding agents on one repository *safe and mergeable*. It is not a coding agent. It is the layer that sits above Claude Code, Cursor Agent, and any ACP-compatible agent.

### The gap it fills

The 2026 ecosystem is saturated with tools that **fan out** — ccmanager, dmux, Superset, subtask, and a dozen others all spawn N agents into N git worktrees. None of them **fan in**. Concretely, four problems remain unsolved:

1. **Worktrees isolate files, not runtime.** Parallel sessions share one local database, one Docker daemon, one port space, one cache directory. Isolation that works in a demo breaks on a real application.
2. **Nothing warns you at write time.** As the GitButler team put it: *"The worktrees are separate, so you can create merge conflicts between them without knowing."* You discover collisions at merge — too late.
3. **Integration is manual.** Best practice today is still "create a staging branch by hand, merge, fix conflicts, pray."
4. **Disk and cost are invisible.** A 2 GB codebase consumed 9.82 GB of worktrees in a 20-minute Cursor session. Token burn multiplies by N with no meter.

crossweave targets exactly these four.

### Non-goals

- Not a new coding agent, and not a task planner that decides how to split work. Humans choose the split.
- Not a visual DAG / canvas orchestrator.
- Not a general cross-vendor memory product (mem0, Cognee, Memorix occupy that space).
- Not a coverage race on agent count. ACP gives breadth for free; we do not hand-write adapters per vendor.
- No cloud sync, no team collaboration, no hosted service in V1.

---

## 2. Architecture

### 2.1 Three founding decisions

**D1 — A daemon owns all state.**
Collision Radar and the Convergence Engine need a process that outlives any single CLI invocation. `cwd` (the crossweave daemon) is the sole owner of the SQLite database. CLI, TUI, and any future desktop client are thin clients speaking JSON-RPC 2.0 over a unix domain socket at `.crossweave/daemon.sock`. This also delivers, from day one, the "desktop app talks to the same core" property that would otherwise require a painful refactor.

**D2 — Two planes, strictly separated.**
- *Control plane*: the daemon. Single source of truth. Owns SQLite, worktrees, leases, processes.
- *Agent plane*: one MCP server instance per session. Agents read and write through it. **No agent ever touches SQLite or another session's worktree directly.**

**D3 — Safe Mode has three enforcement tiers, and the tier is always disclosed.**

| Tier | Condition | Guarantee |
|---|---|---|
| **T1 — enforced** | Agent speaks ACP; permission requests are routed to crossweave | Blocks before the write happens |
| **T2 — enforced** | Claude Code native; `PreToolUse` hook | Blocks before the write happens |
| **T3 — advisory** | Opaque CLI (e.g. Cursor without ACP), driven over PTY | OS-level sandbox + post-hoc detection only |

The active tier is shown in `cw session list`, in the TUI status bar, and in the session banner. Presenting T3 as if it were T1 would be lying to the user about safety; the UI must never do this.

### 2.2 Component map

```
CLI (cw)   ·   TUI (Ink)   ·   [future] Desktop
                   │  JSON-RPC 2.0 over unix socket
                   ▼
┌──────────────────── cwd (daemon) ────────────────────┐
│  Workspace Manager     Session Manager               │
│  Isolation Layer       Lease Manager   Disk Guard    │
│  Event Ledger          Message Bus     Context Store │
│  Collision Radar       Convergence Engine            │
└───────────┬──────────────────────────┬───────────────┘
            │                          │
   Agent Runtime                SQLite + .crossweave/
   ├─ ACP client (primary)
   ├─ Claude Code + hooks (native)
   └─ PTY fallback (opaque agents)
            ▲
   MCP server (one instance per session)
```

### 2.3 On-disk layout

```
<project>/.crossweave/
  daemon.sock
  state.db              # SQLite — single source of truth
  workspace.json        # human-readable mirror, non-authoritative
  worktrees/<session-id>/
  integration/          # scratch worktree owned by Convergence Engine
  logs/<session-id>.log
  events/               # rotated JSONL overflow of the event ledger
~/.config/crossweave/config.json   # global defaults
```

`.crossweave/` is added to `.gitignore` on `cw init`.

---

## 3. Data model

```sql
workspace(id, name, root_path, created_at, default_isolation, safe_mode_tier)

session(id, workspace_id, name, agent_kind, adapter, status,
        worktree_path, branch, created_at, last_active_at,
        token_budget, token_spent, enforcement_tier, pid)

event(id, session_id, ts, kind, payload)          -- append-only; see §4.7

message(id, workspace_id, from_session, to_session, type, body,
        context_ref, created_at, delivered_at, attempts, trust)

context_entry(id, workspace_id, session_id, scope, key, body, created_at)
        -- scope ∈ {private, shared}; shared == explicitly published

file_claim(id, session_id, path, symbol, kind, head_sha, first_seen, last_seen)

contract(id, workspace_id, owner_session, symbol_fqn, sig_hash,
         declared_at, stable_by)
contract_sub(contract_id, session_id)

lease(id, session_id, kind, value, acquired_at, released_at)
        -- kind ∈ {port, db, docker, cache}

merge_trial(id, workspace_id, ts, branches, result, detail)
        -- result ∈ {clean, conflict, test_fail}
```

`event` is the most important table. It backs `cw blame`, and it is the replay source for crash recovery. Every other table is, in principle, rebuildable from it.

Schema migrations are versioned and forward-only, applied by the daemon on start; the daemon refuses to run against a newer schema than it knows.

---

## 4. Components

### 4.1 Workspace Manager

`cw init` · `cw workspace list|switch|info|delete`

A workspace binds to a project root (the git root by default). Metadata: name, root path, creation time, default isolation mode, default safe-mode tier, and its session set. `delete` requires that all sessions be dead, or `--force` plus confirmation.

### 4.2 Session Manager

`cw session new --name <n> --agent claude|cursor|<acp-id> [--no-worktree] [--budget <tokens>]`
`cw session list|attach|kill|resume|rename`

Status is one of `idle | running | waiting | dead`. `--no-worktree` shares the main working directory and prints an explicit warning: collision detection degrades to file-level, and resource leases still apply but the filesystem is no longer isolated. On `kill`, the user is asked whether to remove the worktree (skipped under `--yes`).

### 4.3 Isolation Layer

Each session gets a git worktree at `.crossweave/worktrees/<session-id>` on branch `cw/<session-name>`. If worktree creation fails (dirty index, locked ref, insufficient disk), crossweave falls back to `--no-worktree` **only with explicit confirmation**, never silently, and records the reason in the event ledger.

### 4.4 Lease Manager — runtime isolation

Worktrees isolate files. Leases isolate everything else. On session start the daemon acquires and injects:

| Kind | Mechanism | Injected as |
|---|---|---|
| port | contiguous block of 10 from a configurable range (default 43000–44999) | `CW_PORT_BASE`, `PORT`, plus named ports from config |
| db | pluggable strategy: `schema` (Postgres `cw_<session>`), `file-copy` (SQLite), `branch` (Neon/Supabase API), `none` | `DATABASE_URL` |
| docker | per-session compose project | `COMPOSE_PROJECT_NAME=cw_<session>` |
| cache | per-session cache root | `XDG_CACHE_HOME`, build-tool cache vars |

Leases are released on session death and reclaimed by reconciliation if the daemon crashed (§4.7).

### 4.5 Disk Guard

Tracks per-worktree size. Warns at a configurable threshold (default 2 GB per session, 20 GB per workspace) and refuses new sessions past a hard cap. `cw gc` removes worktrees belonging to dead sessions; it also runs automatically on daemon start. Optional shared build-cache mode is opt-in, since it trades isolation for disk.

### 4.6 Message Bus and Context Store

Message types: `direct`, `broadcast`, `handoff`, `context-share`. Delivery is at-least-once with retry and backoff; undelivered messages persist and are re-offered when the target session next polls. Messages carry `id, from, to, type, body, context_ref, timestamp, trust`.

Context Store holds per-session `private` entries and workspace-level `shared` entries. Only what a session explicitly publishes becomes shared. Handoff attaches a *summary* reference, never a full history dump — the `context_ref` points at context entries, and the receiving agent pulls what it needs through MCP.

MCP tools exposed per session: `cw_send`, `cw_broadcast`, `cw_handoff`, `cw_publish_context`, `cw_read_context`, `cw_inbox`, `cw_check`, `cw_declare_contract`.

### 4.7 Event Ledger, blame, and recovery

Append-only event kinds: `session.created`, `session.started`, `session.exited`, `tool.call`, `file.changed`, `message.sent`, `message.delivered`, `lease.acquired`, `lease.released`, `merge.trial`, `contract.declared`, `contract.changed`.

`cw blame <file>:<line>` resolves the line to a commit via `git blame`, maps the commit to a session through the ledger, then locates the `tool.call` event that produced that hunk — answering "which agent, acting on which prompt, wrote this line."

**Reconciliation on daemon start** (this is how "sessions must be recoverable" is actually implemented): verify each recorded worktree still exists on disk; probe each recorded PID; release leases held by dead sessions; mark unreachable sessions `dead`; replay the ledger tail to rebuild in-memory indexes.

### 4.8 Collision Radar — M3, the differentiator

**Indexing.** For each live session, on filesystem events (debounced 500 ms) the daemon computes the changed-file set against the merge base. Changed files are parsed with tree-sitter to extract top-level symbol ranges; each touched symbol's body is compared to its merge-base version. The result is written as `file_claim` rows at both file and symbol granularity.

**Detection.** When session B is about to write file F or symbol S, the daemon checks whether any other live session already claims F/S with divergent content.

**Delivery.** Claude Code via the `PreToolUse` hook (which queries the daemon and returns advisory text, or blocks when Safe Mode is on and the conflict is a write-write); ACP agents at the tool-call boundary; everyone else via the `cw_check` MCP tool plus the session inbox.

**Contracts.** A session may declare ownership of a public interface:
`cw contract declare --symbol 'src/auth.ts#AuthService' --stable-by 2h`. The signature hash is computed from the symbol's public shape. Sessions whose import graph references that symbol are auto-subscribed. When the hash changes, subscribers receive a precise before/after signature diff — not a chat message.

This is the point of the whole feature: the flagship example from the original brief — *"tell the tests session that I changed the AuthService interface"* — should never need to be typed by a human. The system already knows.

**Noise control** (non-negotiable, because Radar writes into agent context and therefore costs tokens and attention):
- Changes that are whitespace-only, formatting-only, or comment-only are suppressed by comparing normalized symbol text.
- Notifications coalesce by symbol.
- Hard rate limit: at most 6 notifications per 10 minutes per session, configurable.
- A session is notified about symbol S only if it is editing S, or its import graph references S.

### 4.9 Convergence Engine — M4, the moat

The daemon maintains a scratch worktree at `.crossweave/integration`.

**Continuous trial merge.** On each session branch update (debounced), the engine merges every active session branch into a temporary branch off the base and records the outcome in `merge_trial`. Pairwise trials build a conflict graph between sessions.

**Merge order.** From the conflict graph, the engine recommends an order that minimizes cascading conflicts — greedily merging the branches with the fewest conflicting partners first.

**Reporting.** `cw converge status` shows the pairwise conflict matrix and the test result of the full integration, so you learn that sessions A and C will collide *before either finishes*.

**Intent-aware resolution.** When a genuine conflict appears, crossweave can spawn a dedicated resolver session whose prompt contains the merge-base version, both diffs, **and both sessions' stated intent** pulled from the Context Store. Intent is exactly what a human resolver has and `git merge` does not.

### 4.10 Agent Runtime

Primary path is an **ACP client**. ACP is JSON-RPC 2.0 over stdio, backed by Zed, JetBrains, and Google, with 25+ agents and a live registry. Riding it eliminates the per-vendor adapter layer — the most maintenance-hungry part of the original design — and yields structured tool-call and permission events instead of scraped terminal output. It is also what makes Safe Mode T1 possible at all.

Secondary paths: Claude Code natively (hooks + headless SDK + MCP, giving T2), and a PTY fallback for opaque agents (T3).

*Open item for M5:* verify whether Claude Code and Cursor Agent speak ACP natively or require a bridge. The milestone plan must not assume native support before this is confirmed.

### 4.11 Budget and burn meter

Per-session token and cost accounting from adapter-reported usage, with an optional `--budget`. On overrun the session is paused, not killed, and the user is prompted. `cw session list` shows spend per session and workspace total.

### 4.12 TUI

Ink. Square borders, neutral palette with a single accent, short purposeful transitions. Panes: session list with status and enforcement tier, live Radar feed, convergence matrix, and a status bar carrying workspace, active sessions, disk, and burn.

---

## 5. Security

### 5.1 Inter-session prompt injection

**This is the sharpest risk in the design and it is inherent to the message bus.** If session A can place text into session B's context, then A can inject instructions into B. An agent compromised through a malicious file, a dependency, or a web fetch can therefore pivot into every other session in the workspace. The bus is an attack surface, not merely a convenience.

Mitigations, all mandatory:

- Three trust levels: `system` (daemon-generated), `user` (typed by a human), `agent` (produced by an agent). Stored on every message.
- Agent-origin content is always framed with explicit provenance: `<peer-message from="auth" session="s_01H…" trust="agent">…</peer-message>`.
- Agent-origin content is **never** placed in system-prompt position — only in user or tool-result position.
- Bodies are escaped so they cannot spoof the wrapper: occurrences of `<peer-message` and `</peer-message>` are neutralized before framing.
- Radar notifications, being daemon-generated, carry `trust="system"` and must render visually distinct from agent-authored messages.
- Size caps: 8 KB per message, 64 KB per context-share, both configurable.

### 5.2 Filesystem containment

Every path from an agent is resolved with `realpath` and asserted to lie under that session's worktree root; symlink escapes are rejected. The per-session MCP server is scoped so a session can read its own private context and the workspace shared context, and nothing belonging to another session.

### 5.3 Destructive operations

Deleting workspaces, killing sessions with worktree removal, and `cw gc` all require confirmation unless `--yes` is passed or the workspace is in trusted mode.

---

## 6. Milestones

Each milestone ships something usable on its own.

| M | Content | What ships | Est. |
|---|---|---|---|
| **M0** | Daemon + SQLite + Workspace Manager + Session Manager + worktrees + CLI | Table stakes: a competent session manager | 1 wk |
| **M1** | Lease Manager (port/db/docker/cache + env injection) + Disk Guard + `cw gc` | The only tool that isolates *runtime*, not just files | 1 wk |
| **M2** | Event Ledger + `cw blame` + Message Bus + Context Store + per-session MCP server + reconciliation | Agents can talk; full forensics; crash recovery | 1.5 wk |
| **M3** | **Collision Radar** — file+symbol index, contracts and subscriptions, hook/MCP delivery, noise control | 🔑 The differentiator | 2 wk |
| **M4** | **Convergence Engine** — trial-merge daemon, merge ordering, intent-aware resolver | 🔑 The moat | 2 wk |
| **M5** | ACP client + Safe Mode tiers T1/T2/T3 + Cursor + `--trusted` | Broad agent support; real enforcement | 1.5 wk |
| **M6** | TUI + budget/burn meter + polish | 1.0 | 1.5 wk |

**Total ≈ 10.5 weeks.** M0–M2 (3.5 weeks) is already usable daily. M3 is the decision point: if Radar does not change how the work feels, stop before M4.

Radar precedes Convergence deliberately — Radar pays off on every single session, while Convergence only pays off once several sessions run concurrently.

---

## 7. Stack

TypeScript · Node 22+ · `node:sqlite` (avoids the `better-sqlite3` native-build problem when publishing to npm) · `execa` · `simple-git` · `citty` · `tree-sitter` (Radar) · `@modelcontextprotocol/sdk` · Ink (M6) · vitest.

Package `crossweave`, binary `cw`. Name verified free on npm with no colliding GitHub project as of 2026-08-09.

---

## 8. Testing

| M | Must prove |
|---|---|
| M0 | Workspace and session lifecycle; worktree created and removed cleanly |
| M1 | Five concurrent sessions receive non-overlapping leases; disk guard trips at threshold |
| M2 | Bus delivers at-least-once under a restart; `blame` attributes a line to the correct session and prompt; reconciliation recovers from a killed daemon |
| M3 | Radar detects a symbol-level collision **and stays silent on format-only and comment-only changes**; rate limit holds; contract subscribers get the signature diff |
| M4 | Trial merge reports a cross-session conflict before either branch is merged; recommended order reduces conflict count against a naive order |
| M5 | Safe Mode T1 and T2 block a write before it lands; T3 is reported as advisory and never claims otherwise |

Tests are deterministic: no real network, no wall-clock dependence, git fixtures generated per test.

---

## 9. Accepted risks

- **Vendor absorption.** Claude Code and Cursor could ship collision detection natively. Mitigation: Radar and Convergence are cross-agent by construction; a single vendor solving it for its own agent does not solve it for a mixed fleet.
- **ACP coverage uncertainty.** If the major agents are not natively ACP, M5 grows a bridge layer. This is why M5 sits after the differentiating work rather than before it.
- **tree-sitter language coverage.** Radar degrades to file-level granularity for unsupported languages. This is a documented degradation, not a failure.
