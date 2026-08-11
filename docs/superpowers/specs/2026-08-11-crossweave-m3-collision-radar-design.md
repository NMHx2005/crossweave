# crossweave M3 — Collision Radar design

**Date:** 2026-08-11
**Status:** Design, pending plan. Builds on M0–M2 (merged to `main`). Elaborates
`docs/superpowers/specs/2026-08-09-crossweave-design.md` §4.8, §3 (data model),
§6 (milestones) into an implementable spec, resolving the open questions that
section left for milestone time.

## 1. Why this milestone

M0–M2 isolate runtime and let agents talk. Neither stops two agents from editing
the same file, or the same function inside different files, without either of
them knowing. Collision Radar is the design doc's stated differentiator: it
watches what every live session touches, and tells a session — *before* it
writes — that someone else already has divergent changes to the same file or
symbol. M3 ships this in **advisory mode only**: it informs, it does not block.
Blocking (Safe Mode) is M5's job, once ACP gives crossweave a real permission
boundary to enforce against.

## 2. Resolved design questions

These were open in the original design doc and are settled here, each with the
reasoning that produced the decision — a future reader should not have to
re-litigate them.

### 2.1 Symbol parsing: `web-tree-sitter` (WASM), not native `tree-sitter`

The design doc's own Global Constraints declare "two runtime dependencies
total, zero native modules" in the same section that lists `tree-sitter` as
M3's stack — an internal contradiction. The standard `tree-sitter` npm package
loads a native `.node` binding per grammar, which this project has enforced
against strictly through three milestones (M0's ruling on native dependencies,
M2's decision to hand-roll an MCP server rather than take on
`@modelcontextprotocol/sdk`). Grammar-level regex/heuristic parsing was
considered and rejected: TypeScript's generics, decorators, and multi-line
signatures make an accurate top-level-symbol extractor a parser in disguise,
and a wrong range silently mis-attributes a collision — worse than the
performance cost of a real parser.

**Decision:** `web-tree-sitter` — a pure WASM runtime with no native binding —
becomes crossweave's **third and final declared runtime dependency**,
documented as a deliberate, justified exception exactly like M0's `tsc`
ruling. `bun pm ls` plus a check for `preinstall`/`install`/`postinstall`
still governs verification; the rule is "no native code reaches the user",
not "count equals two" — the count is a proxy the project has always been
willing to name an exception to when the reasoning is explicit.

Grammar `.wasm` files (JS/TS, Python) are build-time artifacts: generated once
via `tree-sitter-cli` (a **devDependency**, never touching the end user's
install) and checked into the repo as static assets, or vendored from a
pre-built distribution if one proves reliable during planning. Either way,
nothing downloads or compiles at `bun install` time on a user's machine. This
is a planning-time detail (Task-level, not architecture-level) — the plan must
pick one and verify it holds the zero-runtime-fetch property before shipping.

### 2.2 Language scope: TypeScript/JavaScript + Python

Matches crossweave's own stack (TS/JS) plus the next most common language in
AI-adjacent codebases (Python). Any other file still gets **file-level**
claims (`file_claim.symbol = NULL`) — collision detection degrades gracefully
rather than silently doing nothing, matching the existing "shared worktree
degrades to file-level" precedent from §4.2 of the design doc. Adding a
grammar later is a `.wasm` file plus a parser-adapter, not an architecture
change — the indexing pipeline is language-agnostic by construction (§4
below).

### 2.3 Indexing strategy: continuous file-watcher, not on-demand

An on-demand-only index (built only when a hook fires) would leave every
*other* live session's claims stale unless that session also happens to run
through a hook — which non-Claude-Code sessions (a bare PTY agent, a future
ACP client before M5, or a human editing manually with `--no-worktree`) never
do. A continuous watcher, debounced 500 ms per the design doc, keeps
`file_claim` current regardless of which session asks. The cost is one
`fs.watch` (Bun/Node built-in, no new dependency) per active worktree — bounded
by the number of live sessions, which is already bounded by disk/lease limits
from M1.

### 2.4 Hook wiring: per-session, not global

Researched against Claude Code's actual hook mechanism (`code.claude.com/docs`,
fetched during brainstorming, not assumed):

- `claude --settings '<json>'` accepts an inline settings override for a
  **single process invocation**, at a priority between managed and
  project/local settings files. This lets `ClaudePtyAdapter.spawn()` inject a
  `PreToolUse` hook scoped to exactly the one agent process it is starting —
  **no edit to any settings.json on disk**, so crossweave's hook never
  collides with, or masks, a hook the user already has (hooks from every
  visible scope run in parallel; they merge, they don't override).
- The hook fires for every tool call; a `matcher` restricts it to
  `Edit|Write` — the only tools that mutate files, and the only ones Radar
  cares about intercepting.
- Decision protocol (exit 0, JSON): `hookSpecificOutput.permissionDecision`.
  M3 always returns `"allow"`; when Radar has something to say, it also sets
  `additionalContext`, which Claude Code injects into the agent's next turn as
  advisory text. `"deny"` (blocking) is explicitly **out of scope for M3** —
  that capability exists in the protocol but M5 is where crossweave earns the
  right to use it (real enforcement needs the ACP permission boundary this
  milestone doesn't have).
- The hook subprocess receives `cwd` (the worktree path) and Claude Code's own
  `session_id` on stdin. crossweave already knows the worktree → crossweave
  session mapping, so `cwd` alone is enough to resolve which session is
  asking — no new correlation mechanism needed.
- Default hook timeout is 600s; M3 sets an explicit **5s** timeout on the hook
  entry it injects. A local unix-socket round-trip should resolve in single-digit
  milliseconds; 5s is generous headroom without risking a stuck daemon
  stalling an agent's tool call for minutes.

The hook script itself is a new CLI subcommand, `cw radar-hook` (never invoked
by a human directly) — it reuses the daemon-client machinery every other `cw`
command already has, rather than being a second, parallel implementation.

## 3. Data model

New tables, added as migration index 5 (current `SCHEMA_VERSION` is 4 as of
M2's own fix wave; this migration bumps it to 5, appended after the existing
migrations — never editing one already shipped):

```sql
file_claim(
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,      -- repo-relative
  symbol        TEXT,               -- NULL = file-level claim
  kind          TEXT NOT NULL CHECK (kind IN ('function','class','method','interface','type','const','file')),
  head_sha      TEXT NOT NULL,      -- the commit this claim's body was diffed against (merge-base at index time)
  body_hash     TEXT NOT NULL,      -- hash of the NORMALIZED symbol/file body (whitespace/comments stripped)
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  UNIQUE (session_id, path, symbol)
)

contract(
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  symbol_fqn    TEXT NOT NULL,      -- e.g. "src/auth.ts#AuthService"
  sig_hash      TEXT NOT NULL,      -- hash of the symbol's PUBLIC shape only
  declared_at   TEXT NOT NULL,
  stable_by     TEXT                -- ISO 8601 timestamp; NULL = no stated expiry
)

contract_sub(
  contract_id   TEXT NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  subscribed_at TEXT NOT NULL,
  PRIMARY KEY (contract_id, session_id)
)
```

`file_claim` is per-session, per-symbol, upserted on `UNIQUE (session_id,
path, symbol)` — a session's claim on a symbol updates in place as it keeps
editing, rather than accumulating rows. `body_hash` changing is what
distinguishes "still editing the same thing" from "reverted to the merge-base
version, no longer actually diverging" (a claim whose `body_hash` matches
merge-base again should be deleted, not kept — see §4).

## 4. Indexing pipeline

One watcher per workspace, covering every active session's worktree
(`.crossweave/worktrees/*`), debounced 500 ms per burst of filesystem events.
On a debounce firing, for each worktree that had activity:

1. `git diff --name-only <merge-base>..HEAD` (plus working-tree diff, since
   most of a session's life is uncommitted) to get the changed-file set,
   relative to that session's own fork point — reusing the exact fork-point
   concept M2's blame fix already established (`session.forked`'s recorded
   hash), not a freshly-derived "base branch", for the same reason M2's fix
   wave gave: a live-derived base can drift if the user checks out something
   else in the main worktree.
2. For each changed file with a supported extension (`.ts`, `.tsx`, `.js`,
   `.jsx`, `.py`): parse with the matching `web-tree-sitter` grammar, walk
   top-level declarations, extract each one's byte range.
3. For each extracted symbol: read its current body, normalize (strip
   comments and collapse whitespace), hash it. Compare against the
   merge-base version of that same range (via `git show
   <forkPoint>:<path>`, sliced to the corresponding symbol if it existed
   there, or "absent" if the symbol is new).
   - **Unchanged after normalization** (edit was whitespace/comment-only):
     no claim written, and any existing claim for that symbol from this
     session is removed — this is the noise-control rule applied at the
     source, not just at notification time (design doc §4.8's mandate).
   - **Changed**: upsert a `file_claim` row.
4. A file that fails to parse (syntax error mid-edit, or an unsupported
   extension) gets a **file-level** claim (`symbol = NULL`) instead — the
   degrade-gracefully path from §2.2.
5. A session whose worktree no longer has ANY changed files relative to its
   fork point (e.g., it committed and its working tree is now clean) has all
   its `file_claim` rows for that workspace cleared — a claim represents
   *current* divergence, not history; `cw blame`/the event ledger already
   owns history.

This whole pipeline is one pure function from `(old tree, new tree,
grammar)` to `symbol ranges + hashes` at its parsing core — kept in its own
module, unit-testable against fixed source strings with no daemon, no git,
no filesystem, matching the pattern `EventLedger` established in M2 (`git`
calls isolated behind a thin seam, core logic tested against fixtures).

## 5. Detection and delivery

New RPC method `radar.check`:

```ts
'radar.check': (p) => {
  // { workspaceId, sessionId, path, symbol?: string }
  // returns: { collisions: Array<{ sessionId, sessionName, path, symbol, kind }> }
}
```

Returns every OTHER live session's claim on the same `path` (and, if
`symbol` was given, matching `symbol` too — a file-level query without a
symbol matches any claim on that path regardless of the other session's
granularity, so a file-level claim and a symbol-level claim on the same file
still collide). Two claims only collide if their `body_hash`es differ from
each other's merge-base-relative baseline in a way that means real, divergent
content — not just "both touched this file" (which is common and harmless if
they're editing different, non-overlapping regions; §4's per-symbol
granularity is what makes this precise instead of file-level-only).

**Delivery paths**, all converging on `radar.check`:

- **Claude Code, via `cw radar-hook`** (§2.4): the hook script parses
  `PreToolUse`'s stdin JSON for the tool name (`Edit`/`Write`) and its target
  path, calls `radar.check`, and if the result is non-empty, formats it into
  `additionalContext` — a short, structured note (not a full diff): which
  session, which symbol, "last touched N seconds ago". Always
  `permissionDecision: "allow"` in M3.
- **`cw_check` MCP tool** (M2 stubbed the tool set to explicitly exclude
  `cw_check`/`cw_declare_contract` until this milestone — M3 is where both
  get implemented for real and registered). Same `radar.check` call, formatted
  as MCP tool-result JSON instead of hook `additionalContext`.
- **Everyone else** (a bare PTY session, `--no-worktree` sessions, any future
  ACP agent before M5): no hook exists for them, so Radar notifications reach
  them exclusively through the session inbox — `MessageBus`'s existing
  `type: 'system'`, `trust: 'system'` path from M2, no new delivery mechanism
  needed. A collision found during the watcher's own indexing pass (not
  triggered by any particular session's tool call) is delivered this way too
  — the retroactive-notice path the design doc names for the "two sessions
  wrote inside the same debounce window" case.

## 6. Noise control

Per the design doc's non-negotiable list, each mechanism placed where it's
cheapest to enforce:

- **Whitespace/comment-only changes never produce a claim at all** (§4, at
  index time — not filtered later, never generated).
- **Rate limit**: at most 6 notifications per 10 minutes per session,
  enforced in-memory (`Map<sessionId, timestamp[]>` in the daemon process,
  pruned on each check) — resets on daemon restart, an accepted, documented
  limitation matching this project's general posture on in-memory state that
  reconciliation doesn't try to perfectly resurrect.
- **Coalescing**: multiple pending notices for the same symbol, to the same
  session, within the rate-limit window collapse to one (the most recent
  state), not one message per index pass.
- **Reference scoping**: a session is only notified about symbol S if it is
  editing S itself, or `ripgrep`ing S's name across that session's own
  touched files (and their direct `import`/`from` lines) finds a hit — the
  design doc's own chosen approximation of a real import graph, explicitly
  tuned to over-notify rather than silently miss. No import-graph subsystem
  in M3; the interface to the reference check is one function
  (`references(sessionId, symbolName): boolean`) so a real resolver can
  replace it later without touching the rest of Radar.

## 7. Contracts

`cw contract declare --symbol '<file>#<Name>' --stable-by <duration>`:

- Resolves `<file>#<Name>` against the CURRENT indexed symbol (must exist and
  be a top-level declaration the parser recognized — an unparseable target is
  a clean `CONTRACT_TARGET_NOT_FOUND` error, not a confusing silent no-op).
- `sig_hash` is computed from the symbol's **public shape only** — for a
  TS/JS class or interface, its exported member signatures (names, parameter
  types, return types), not its implementation body; a body-only change never
  fires a contract notification, matching the whole point of a *contract*
  being about the interface, not the internals.
- Auto-subscription: any live session whose reference check (§6) finds the
  symbol name in its own touched files is subscribed automatically — no
  explicit `cw contract subscribe` command needed for the common case (design
  doc's flagship example: nobody should have to type "tell the tests session
  I changed AuthService").
- When a re-index finds `sig_hash` changed for a declared contract, every
  subscriber gets a message (`type: 'system'`) containing the symbol's
  before/after public-shape diff — computed once by the daemon, not
  re-derived per subscriber.

`cw_declare_contract` (the MCP tool M2 left unregistered) becomes a thin
wrapper calling the same domain logic as the CLI command.

## 8. Security

- `radar.check`'s inputs (`path`, `symbol`) originate from the agent's own
  tool-call arguments (via the hook) or MCP tool arguments (via
  `cw_check`) — both are external-origin strings and go through
  `assertContained` before touching the filesystem or a git command, matching
  the constraint this project has held since M0 and specifically fixed a
  regression of in M1 (Task 8's `db.url` path-traversal finding).
- The hook subprocess (`cw radar-hook`) runs with whatever privileges the
  agent process already has — it is not a new privilege boundary, it is a
  read-only query against the daemon's existing socket (already `0600`,
  already scoped to the OS user per the design doc's §5.2). No new attack
  surface beyond what `cw_check` already has as an MCP tool.
- Radar notifications carry `trust: 'system'` (daemon-generated), per the
  inter-session prompt injection mitigations already mandatory since M2 — they
  must render visually distinct from agent-authored messages and can never be
  framed as anything but system-originated advisory text.

## 9. Testing

- **Symbol extraction**: fixed source strings in, expected `{range, kind,
  normalizedHash}` out — no daemon, no git, no filesystem. One fixture set
  per supported language, covering: a plain function, a class with methods,
  a generic/decorated declaration (TS), a nested function that should NOT be
  extracted as top-level, a syntax-error file (must degrade to file-level,
  not throw).
- **Indexing pipeline, end to end**: real git fixture (extending
  `makeGitFixture`/`commitFile` from M2), real worktree, write a file, wait
  past the debounce, assert the resulting `file_claim` row. A second test:
  revert the file to its merge-base content, assert the claim is removed
  (§4's "unchanged after normalization" and "clean working tree" cases both
  need this).
- **Detection**: two sessions, two worktrees, divergent edits to the same
  symbol — `radar.check` from either side finds the other; edits to
  non-overlapping symbols in the same file do NOT collide.
- **Noise control**: a whitespace-only edit produces no notification; more
  than 6 notifications in a 10-minute window get suppressed (with a
  controllable clock seam, not a real 10-minute sleep); a reference-check
  negative correctly withholds a notification.
- **Hook wiring**: feed `cw radar-hook` real `PreToolUse`-shaped stdin JSON
  (matching the schema confirmed against Claude Code's actual docs), assert
  the output JSON's `hookSpecificOutput` shape is correct for both the
  no-collision and collision cases — this is a contract test against an
  external system's protocol, so it deserves its own explicit test file
  rather than being folded into the general MCP/CLI test suites.
- **Contracts**: declare, verify auto-subscription picks up a referencing
  session, verify a body-only change does NOT notify, verify a signature
  change does.

## 10. Deferred to M4 and beyond (explicitly not in M3)

Blocking mode (`permissionDecision: "deny"` when Safe Mode is on) — M5, once
ACP gives a real permission boundary. A true import graph (module resolution
across tsconfig paths, monorepo aliases, re-exports) — post-1.0 per the
design doc, the reference-check interface is kept narrow specifically so this
swap is possible later without touching the rest of Radar. Additional
language grammars beyond TS/JS/Python. The Convergence Engine's own use of
the conflict information Radar surfaces (M4 consumes `file_claim`/collision
data to build its pairwise conflict graph, but does not exist yet).
